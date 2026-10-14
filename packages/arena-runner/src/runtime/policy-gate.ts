import type { Bot } from 'mineflayer';

export class PolicyCompetitorGate {
  readonly #bot: Bot;
  readonly #onIneligible: () => void;
  #active = true;
  #closed = false;

  constructor(bot: Bot, onIneligible: () => void) {
    this.#bot = bot;
    this.#onIneligible = onIneligible;
    bot.on('game', this.#onGame);
    bot.on('death', this.#onDeath);
    this.#refresh();
  }

  get active(): boolean {
    if (this.#closed) return false;
    this.#refresh();
    return this.#active;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#active = false;
    this.#bot.removeListener('game', this.#onGame);
    this.#bot.removeListener('death', this.#onDeath);
  }

  #onGame = (): void => {
    this.#refresh();
  };

  #onDeath = (): void => {
    this.#deactivate();
  };

  #refresh(): void {
    if (this.#closed || !this.#active) return;
    const gameMode = this.#bot.game.gameMode;
    if (this.#bot.health > 0 && (gameMode === 'survival' || gameMode === 'adventure')) return;
    this.#deactivate();
  }

  #deactivate(): void {
    if (this.#closed || !this.#active) return;
    this.#active = false;
    this.#onIneligible();
  }
}
