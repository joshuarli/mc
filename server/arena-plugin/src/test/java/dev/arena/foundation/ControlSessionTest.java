package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

final class ControlSessionTest {
    private static final String RUN_ID = "queue-saturation";
    private static final int SOCKET_TIMEOUT_MILLIS = 5_000;

    @Test
    void rejectsThe129thUndrainedCommandAndClosesItsWorkerThreads() throws Exception {
        InetAddress loopback = InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        try (ServerSocket listener = new ServerSocket()) {
            listener.bind(new InetSocketAddress(loopback, 0));
            listener.setSoTimeout(SOCKET_TIMEOUT_MILLIS);
            ControlSession session = new ControlSession(RUN_ID, listener.getLocalPort(), "test_control_token");
            session.start();

            try {
                try (Socket peer = listener.accept()) {
                    peer.setSoTimeout(SOCKET_TIMEOUT_MILLIS);
                    DataInputStream input = new DataInputStream(peer.getInputStream());
                    DataOutputStream output = new DataOutputStream(peer.getOutputStream());

                    ControlProtocol.Envelope hello = readFrame(input);
                    assertEquals(ControlProtocol.Type.HELLO, hello.type());
                    sendFrame(output, envelope(BigInteger.ONE, ControlProtocol.Type.ACK,
                            new ControlProtocol.EmptyPayload(), Optional.of(BigInteger.ONE)));
                    session.publishReady(new ControlProtocol.ReadyPayload(
                            new ControlProtocol.ServerIdentity("paper", "test", "26.1.2", 775),
                            new ControlProtocol.PluginIdentity("ArenaFoundation", "test"),
                            ControlProtocol.Capability.SUPPORTED));
                    ControlProtocol.Envelope ready = readFrame(input);
                    assertEquals(ControlProtocol.Type.READY, ready.type());

                    for (int sequence = 2; sequence <= 130; sequence++) {
                        try {
                            sendFrame(output, envelope(BigInteger.valueOf(sequence), ControlProtocol.Type.START,
                                    new ControlProtocol.EmptyPayload(), Optional.empty()));
                        } catch (IOException connectionClosedAfterOverflow) {
                            break;
                        }
                    }

                    awaitFailure(session);
                    IOException failure = session.failure();
                    assertEquals("control inbound command queue reached its fixed capacity", failure.getMessage());
                    assertEquals(128, session.inboundQueueDepth());
                    assertPeerClosed(input);
                }
            } finally {
                session.close();
            }

            awaitNoControlWorkers();
        }
    }

    private static ControlProtocol.Envelope envelope(BigInteger sequence, ControlProtocol.Type type,
            ControlProtocol.Payload payload, Optional<BigInteger> correlation) {
        return new ControlProtocol.Envelope(
                new ControlProtocol.Header(RUN_ID, sequence, correlation), type, payload);
    }

    private static void sendFrame(DataOutputStream output, ControlProtocol.Envelope envelope) throws IOException {
        output.write(ControlProtocol.encodeFrame(envelope));
        output.flush();
    }

    private static ControlProtocol.Envelope readFrame(DataInputStream input) throws IOException {
        int bodyLength = input.readInt();
        assertTrue(bodyLength > 0 && bodyLength <= ControlProtocol.MAX_FRAME_BYTES);
        byte[] body = new byte[bodyLength];
        input.readFully(body);
        return ControlProtocol.decodeBody(body);
    }

    private static void assertPeerClosed(DataInputStream input) throws IOException {
        try {
            assertEquals(-1, input.read(), "the plugin must close the saturated control connection");
        } catch (SocketException reset) {
        }
    }

    private static void awaitFailure(ControlSession session) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (session.failure() == null && System.nanoTime() < deadline) {
            Thread.sleep(5);
        }
        assertTrue(session.failure() != null, "queue saturation must fail the control session");
    }

    private static void awaitNoControlWorkers() throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (hasControlWorker() && System.nanoTime() < deadline) {
            Thread.sleep(5);
        }
        assertFalse(hasControlWorker(), "closing the failed session must terminate both I/O workers");
    }

    private static boolean hasControlWorker() {
        List<Thread> threads = List.copyOf(Thread.getAllStackTraces().keySet());
        return threads.stream().anyMatch(thread -> thread.isAlive()
                && (thread.getName().equals("arena-control-reader")
                        || thread.getName().equals("arena-control-writer")));
    }
}
