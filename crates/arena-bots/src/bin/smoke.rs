use std::time::Duration;

use azalea::{BlockPos, Event, WalkDirection, prelude::*};
use eyre::{Context, bail, ensure};
use tokio::time::timeout;

const EVENT_TIMEOUT: Duration = Duration::from_secs(20);

#[tokio::main]
async fn main() -> eyre::Result<()> {
    let mut args = std::env::args().skip(1);
    let host = args.next().context("missing loopback host")?;
    let port = args.next().context("missing server port")?;
    ensure!(args.next().is_none(), "unexpected smoke client arguments");
    ensure!(host == "127.0.0.1", "smoke clients may only connect to IPv4 loopback");
    let port: u16 = port.parse().context("invalid server port")?;
    ensure!(port != 0, "server port must be nonzero");
    let address = format!("{host}:{port}");

    let mut first = SmokeClient::join("ArenaOne", &address).await?;
    first.wait_for_spawn_and_chunk().await?;
    let mut second = SmokeClient::join("ArenaTwo", &address).await?;
    second.wait_for_spawn_and_chunk().await?;

    let start = first.client.entity().position()?;
    first.client.walk(WalkDirection::Forward);
    let movement = first.wait_until_moved(start).await;
    first.client.walk(WalkDirection::None);
    movement?;

    let chest_position = BlockPos::new(2, 64, 0);
    first.client.look_at(chest_position.center());
    first.wait_for_ticks(1).await?;
    let chest = timeout(
        EVENT_TIMEOUT,
        first.client.open_container_at(chest_position),
    )
    .await
    .context("timed out opening the fixture chest")??;
    let Some(chest) = chest else {
        bail!("server did not open the fixture chest");
    };
    let contents = chest
        .contents()
        .ok_or_else(|| eyre::eyre!("fixture chest closed before contents arrived"))?;
    ensure!(!contents.is_empty(), "fixture chest contents are empty");
    chest.shift_click(0);
    drop(chest);
    first.wait_for_ticks(5).await?;

    let target_id = first.wait_for_player(&second.client).await?;
    let target = first.client.entity_ref_for(target_id);
    let distance = target.distance_to_client()?;
    ensure!(distance <= 3.0, "smoke clients are outside attack reach: {distance:.2}");
    target.look_at()?;
    first.wait_for_ticks(1).await?;
    first.wait_until_attack_ready().await?;
    first.client.attack(target_id);
    first.wait_for_ticks(5).await?;

    first.disconnect().await?;
    second.disconnect().await?;
    println!("ARENA_CLIENT_OK|spawn=2|chunks=2|move=1|chest=1|attack=1|disconnect=2");
    Ok(())
}

struct SmokeClient {
    client: Client,
    events: tokio::sync::mpsc::UnboundedReceiver<Event>,
    disconnected: bool,
}

impl SmokeClient {
    async fn join(username: &str, address: &str) -> eyre::Result<Self> {
        let (client, events) = Client::join(Account::offline(username), address)
            .await
            .with_context(|| format!("failed to connect {username} to {address}"))?;
        Ok(Self {
            client,
            events,
            disconnected: false,
        })
    }

    async fn wait_for_spawn_and_chunk(&mut self) -> eyre::Result<()> {
        timeout(EVENT_TIMEOUT, async {
            let mut spawned = false;
            let mut received_chunk = false;
            while let Some(event) = self.events.recv().await {
                match event {
                    Event::Spawn => spawned = true,
                    Event::ReceiveChunk(_) => received_chunk = true,
                    Event::Disconnect(reason) => {
                        bail!("client disconnected before spawning: {reason:?}");
                    }
                    Event::ConnectionFailed(error) => {
                        bail!("client connection failed before spawning: {error}");
                    }
                    _ => {}
                }
                if spawned && received_chunk {
                    return Ok(());
                }
            }
            bail!("client event stream ended before spawning");
        })
        .await
        .context("timed out waiting for spawn and chunk data")?
    }

    async fn wait_until_moved(&mut self, start: azalea::Vec3) -> eyre::Result<()> {
        timeout(EVENT_TIMEOUT, async {
            while let Some(event) = self.events.recv().await {
                match event {
                    Event::Disconnect(reason) => {
                        bail!("client disconnected during movement: {reason:?}");
                    }
                    Event::ConnectionFailed(error) => {
                        bail!("client connection failed during movement: {error}");
                    }
                    _ => {}
                }
                let position = self.client.entity().position()?;
                let dx = position.x - start.x;
                let dz = position.z - start.z;
                if dx * dx + dz * dz >= 0.04 {
                    return Ok(());
                }
            }
            bail!("client event stream ended during movement");
        })
        .await
        .context("timed out waiting for real client movement")?
    }

    async fn wait_for_player(
        &mut self,
        target: &Client,
    ) -> eyre::Result<azalea::ecs::entity::Entity> {
        timeout(EVENT_TIMEOUT, async {
            loop {
                if let Some(entity) = self.client.entity_id_by_uuid(target.uuid()) {
                    return Ok(entity);
                }
                match self.events.recv().await {
                    Some(Event::Disconnect(reason)) => {
                        bail!("client disconnected while waiting for its target: {reason:?}");
                    }
                    Some(Event::ConnectionFailed(error)) => {
                        bail!("client connection failed while waiting for its target: {error}");
                    }
                    Some(_) => {}
                    None => bail!("client event stream ended while waiting for its target"),
                }
            }
        })
        .await
        .context("timed out waiting for the second player to become visible")?
    }

    async fn wait_until_attack_ready(&mut self) -> eyre::Result<()> {
        timeout(EVENT_TIMEOUT, async {
            while self.client.has_attack_cooldown() {
                match self.events.recv().await {
                    Some(Event::Disconnect(reason)) => {
                        bail!("client disconnected while waiting for attack cooldown: {reason:?}");
                    }
                    Some(Event::ConnectionFailed(error)) => {
                        bail!("client connection failed while waiting for attack cooldown: {error}");
                    }
                    Some(_) => {}
                    None => bail!("client event stream ended while waiting for attack cooldown"),
                }
            }
            Ok(())
        })
        .await
        .context("timed out waiting for the vanilla attack cooldown")?
    }

    async fn wait_for_ticks(&mut self, ticks: usize) -> eyre::Result<()> {
        timeout(EVENT_TIMEOUT, async {
            let mut elapsed = 0;
            while elapsed < ticks {
                match self.events.recv().await {
                    Some(Event::Tick) => elapsed += 1,
                    Some(Event::Disconnect(reason)) => {
                        bail!("client disconnected before action completed: {reason:?}");
                    }
                    Some(Event::ConnectionFailed(error)) => {
                        bail!("client connection failed before action completed: {error}");
                    }
                    Some(_) => {}
                    None => bail!("client event stream ended before action completed"),
                }
            }
            Ok(())
        })
        .await
        .context("timed out waiting for client ticks")?
    }

    async fn disconnect(&mut self) -> eyre::Result<()> {
        self.client.disconnect();
        timeout(EVENT_TIMEOUT, async {
            while let Some(event) = self.events.recv().await {
                if let Event::Disconnect(_) = event {
                    self.disconnected = true;
                    self.client.exit();
                    return Ok(());
                }
            }
            bail!("client event stream ended before disconnect was observed");
        })
        .await
        .context("timed out waiting for the client disconnect event")?
    }
}

impl Drop for SmokeClient {
    fn drop(&mut self) {
        if !self.disconnected {
            self.client.disconnect();
            self.client.exit();
        }
    }
}
