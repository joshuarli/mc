package dev.arena.foundation;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.math.BigInteger;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Optional;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

final class ControlSession implements AutoCloseable {
    private static final int INBOUND_COMMAND_CAPACITY = 128;
    private static final int OUTBOUND_MESSAGE_CAPACITY = 256;
    private static final int CONNECT_TIMEOUT_MILLIS = 10_000;

    private record Outbound(ControlProtocol.Type type, ControlProtocol.Payload payload,
            Optional<BigInteger> correlation, boolean readiness) {}

    private final String runId;
    private final int port;
    private final String token;
    private final ArrayBlockingQueue<ControlProtocol.Envelope> inbound =
            new ArrayBlockingQueue<>(INBOUND_COMMAND_CAPACITY);
    private final ArrayBlockingQueue<Outbound> outbound = new ArrayBlockingQueue<>(OUTBOUND_MESSAGE_CAPACITY);
    private final CountDownLatch helloAcknowledged = new CountDownLatch(1);
    private final CountDownLatch readinessSent = new CountDownLatch(1);
    private final AtomicReference<IOException> failure = new AtomicReference<>();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicBoolean ready = new AtomicBoolean();
    private final AtomicReference<BigInteger> helloAckSequence = new AtomicReference<>();
    private volatile Socket socket;
    private volatile Thread writerThread;
    private volatile Thread readerThread;
    private volatile BigInteger highestSentSequence = BigInteger.ZERO;

    ControlSession(String runId, int port, String token) {
        this.runId = runId;
        this.port = port;
        this.token = token;
    }

    void start() {
        if (writerThread != null) {
            throw new IllegalStateException("control session can start only once");
        }
        writerThread = new Thread(this::writeLoop, "arena-control-writer");
        writerThread.setDaemon(true);
        writerThread.start();
    }

    boolean isReady() {
        return ready.get();
    }

    IOException failure() {
        return failure.get();
    }

    int inboundQueueDepth() {
        return inbound.size();
    }

    ControlProtocol.Envelope poll() {
        return inbound.poll();
    }

    void publishReady(ControlProtocol.ReadyPayload payload) {
        enqueue(new Outbound(ControlProtocol.Type.READY, payload, Optional.empty(), true));
    }

    void sendEvent(ControlProtocol.Type type, ControlProtocol.Payload payload) {
        if (type == ControlProtocol.Type.HELLO || type == ControlProtocol.Type.READY
                || type == ControlProtocol.Type.PREPARE || type == ControlProtocol.Type.START
                || type == ControlProtocol.Type.ABORT || type == ControlProtocol.Type.ACK) {
            throw new IllegalArgumentException("message type is not a plugin event");
        }
        enqueue(new Outbound(type, payload, Optional.empty(), false));
    }

    void acknowledge(BigInteger requestSequence) {
        enqueue(new Outbound(ControlProtocol.Type.ACK, new ControlProtocol.EmptyPayload(),
                Optional.of(requestSequence), false));
    }

    void reject(BigInteger requestSequence, ControlProtocol.ErrorCode code, String message) {
        enqueue(new Outbound(ControlProtocol.Type.ERROR, new ControlProtocol.ErrorPayload(code, message),
                Optional.of(requestSequence), false));
    }

    private void enqueue(Outbound message) {
        if (closed.get() || failure.get() != null) {
            throw new IllegalStateException("control session is not available");
        }
        if (!outbound.offer(message)) {
            fail(new IOException("control outbound queue reached its fixed capacity"));
            throw new IllegalStateException("control outbound queue is full");
        }
    }

    private void writeLoop() {
        BigInteger sequence = BigInteger.ZERO;
        Socket connection = new Socket();
        socket = connection;
        if (closed.get()) {
            closeSocket();
            return;
        }
        try (connection) {
            connection.connect(new InetSocketAddress(
                    InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), port), CONNECT_TIMEOUT_MILLIS);
            if (closed.get()) {
                return;
            }
            readerThread = new Thread(() -> readLoop(connection), "arena-control-reader");
            readerThread.setDaemon(true);
            readerThread.start();

            DataOutputStream output = new DataOutputStream(connection.getOutputStream());
            sequence = sequence.add(BigInteger.ONE);
            send(output, new ControlProtocol.Envelope(
                    new ControlProtocol.Header(runId, sequence, Optional.empty()),
                    ControlProtocol.Type.HELLO,
                    new ControlProtocol.HelloPayload(token, ControlProtocol.Capability.SUPPORTED)));
            highestSentSequence = sequence;
            long helloDeadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(CONNECT_TIMEOUT_MILLIS);

            while (!closed.get()) {
                if (!helloAcknowledged.await(250, TimeUnit.MILLISECONDS)) {
                    if (failure.get() != null) {
                        return;
                    }
                    if (System.nanoTime() >= helloDeadline) {
                        throw new IOException("runner did not acknowledge the authenticated hello in time");
                    }
                    continue;
                }

                Outbound next = outbound.poll(250, TimeUnit.MILLISECONDS);
                if (next == null) {
                    if (failure.get() != null) {
                        return;
                    }
                    continue;
                }
                if (!ready.get() && !next.readiness()) {
                    throw new IOException("control event was queued before authenticated readiness");
                }
                sequence = sequence.add(BigInteger.ONE);
                if (sequence.compareTo(ControlProtocol.MAX_U64) > 0) {
                    throw new IOException("control sequence exhausted the u64 range");
                }
                Optional<BigInteger> correlation = next.readiness()
                        ? Optional.ofNullable(helloAckSequence.get())
                        : next.correlation();
                if (next.readiness() && correlation.isEmpty()) {
                    throw new IOException("authenticated hello acknowledgment is missing");
                }
                ControlProtocol.Envelope envelope = new ControlProtocol.Envelope(
                        new ControlProtocol.Header(runId, sequence, correlation), next.type(), next.payload());
                highestSentSequence = sequence;
                send(output, envelope);
                if (next.readiness()) {
                    ready.set(true);
                    readinessSent.countDown();
                }
            }
        } catch (IOException | InterruptedException | RuntimeException connectionFailure) {
            if (!closed.get()) {
                fail(new IOException("control connection failed", connectionFailure));
            }
            if (connectionFailure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
        } finally {
            closeSocket();
        }
    }

    private void readLoop(Socket connection) {
        BigInteger lastSequence = BigInteger.ZERO;
        try (DataInputStream input = new DataInputStream(connection.getInputStream())) {
            while (!closed.get()) {
                int bodyLength;
                try {
                    bodyLength = input.readInt();
                } catch (EOFException endOfStream) {
                    throw new IOException("runner closed the control connection", endOfStream);
                }
                if (bodyLength <= 0 || bodyLength > ControlProtocol.MAX_FRAME_BYTES) {
                    throw new IOException("runner sent an invalid control frame length");
                }
                byte[] body = new byte[bodyLength];
                input.readFully(body);
                ControlProtocol.Envelope message = ControlProtocol.decodeBody(body);
                if (!runId.equals(message.header().runId())) {
                    throw new IOException("runner control message has a different run id");
                }
                if (message.header().sequence().compareTo(lastSequence) <= 0) {
                    throw new IOException("runner control sequence is not strictly increasing");
                }
                lastSequence = message.header().sequence();

                if (helloAckSequence.get() == null) {
                    if (message.type() != ControlProtocol.Type.ACK
                            || message.header().correlation().filter(BigInteger.ONE::equals).isEmpty()) {
                        throw new IOException("runner did not acknowledge the authenticated hello");
                    }
                    helloAckSequence.set(message.header().sequence());
                    helloAcknowledged.countDown();
                    continue;
                }

                if (!ready.get()) {
                    try {
                        if (!readinessSent.await(CONNECT_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS) || !ready.get()) {
                            throw new IOException("runner sent a command before plugin readiness");
                        }
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IOException("control reader was interrupted before readiness", interrupted);
                    }
                }
                if (message.type() == ControlProtocol.Type.ACK) {
                    BigInteger correlation = message.header().correlation().orElseThrow();
                    if (correlation.compareTo(highestSentSequence) > 0) {
                        throw new IOException("runner acknowledged an unsent plugin sequence");
                    }
                    continue;
                }
                if (message.type() != ControlProtocol.Type.PREPARE && message.type() != ControlProtocol.Type.START
                        && message.type() != ControlProtocol.Type.ABORT) {
                    throw new IOException("runner sent a plugin-only control event");
                }
                if (!inbound.offer(message)) {
                    throw new IOException("control inbound command queue reached its fixed capacity");
                }
            }
        } catch (IOException | RuntimeException protocolFailure) {
            if (!closed.get()) {
                fail(protocolFailure instanceof IOException ioFailure
                        ? ioFailure
                        : new IOException("invalid runner control message", protocolFailure));
            }
        } finally {
            closeSocket();
        }
    }

    private static void send(DataOutputStream output, ControlProtocol.Envelope message) throws IOException {
        output.write(ControlProtocol.encodeFrame(message));
        output.flush();
    }

    private void fail(IOException reason) {
        failure.compareAndSet(null, reason);
        helloAcknowledged.countDown();
        closeSocket();
    }

    private void closeSocket() {
        Socket connection = socket;
        if (connection != null && !connection.isClosed()) {
            try {
                connection.close();
            } catch (IOException ignored) {
            }
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        closeSocket();
        Thread writer = writerThread;
        Thread reader = readerThread;
        if (writer != null) {
            writer.interrupt();
        }
        if (reader != null) {
            reader.interrupt();
        }
        join(writer);
        join(reader);
    }

    private static void join(Thread thread) {
        if (thread == null || thread == Thread.currentThread()) {
            return;
        }
        try {
            thread.join(1_000);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
