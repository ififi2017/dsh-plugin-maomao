import { randomBytes } from 'node:crypto';

const windowMs = 5 * 60_000;

// One in-memory check per channel. Only the exact message in the selected
// bound conversation can advance it, and later turns cannot overwrite it.
export class ReplyCheck {
  #check;

  start(route) {
    if (['received', 'sending'].includes(this.read().status)) return { status: 'busy' };
    this.#check = {
      route, text: `猫猫，请用一句话打招呼。测试编号 ${randomBytes(6).toString('hex')}`,
      status: 'waiting', expires: Date.now() + windowMs,
    };
    return this.read();
  }

  read() {
    const check = this.#check;
    if (!check) return { status: 'idle' };
    const { route, text, status, expires } = check;
    if (Date.now() >= expires && ['waiting', 'received', 'sending'].includes(status)) {
      check.status = status === 'waiting' ? 'no_message' : 'processing_timeout';
    }
    return { route, text, status: check.status, expires };
  }

  receive(route, text) {
    const check = this.#check;
    if (!check || this.read().status !== 'waiting' || check.route !== route || check.text !== text) return null;
    check.status = 'received';
    check.expires = Date.now() + windowMs;
    return (status) => {
      if (this.#check === check && ['received', 'sending'].includes(this.read().status)) check.status = status;
    };
  }
}
