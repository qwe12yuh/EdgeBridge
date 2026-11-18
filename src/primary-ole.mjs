export class PrimaryOle {
  constructor(send) { this.send = send; }

  observe(event) {
    if (event.event === 'source-prepare') {
      this.source = { id: event.id, generation: event.observedGeneration, seq: 0 };
    } else if (event.event === 'ended' && this.matches(this.target, event)) {
      this.target = undefined;
    }
  }

  matches(session, message) {
    return session && session.id === message.id &&
      (message.generation === undefined || session.generation === message.generation);
  }

  sourceCommand(message) {
    if (['candidate', 'candidate-ended'].includes(message.command)) {
      return this.send({ ...message, routeSeq: message.seq });
    }
    if (!this.matches(this.source, message)) return;
    const session = this.source;
    const kind = message.command === 'commit' ? 'source-commit' : 'source-reset';
    const send = this.send({ ...message, command: kind, generation: session.generation, sourceSeq: ++session.seq });
    if (kind === 'source-reset') this.source = undefined;
    return send;
  }

  targetCommand(message) {
    if (message.command === 'prepare') {
      if (this.target) throw Error('Primary OLE target is already occupied');
      this.target = { id: message.id, generation: message.generation, seq: 0 };
    }
    if (!this.matches(this.target, message)) return;
    return this.send({ ...message, generation: this.target.generation, seq: ++this.target.seq,
      ...(message.command === 'prepare' ? { leaseMs: 2000 } : {}) });
  }

  heartbeat() {
    if (this.target) return this.targetCommand({ command: 'heartbeat', id: this.target.id, generation: this.target.generation });
  }
}
