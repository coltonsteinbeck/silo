/** Holds a single response until its complete transcript is approved. */
export class VoiceOutputGate {
  private pending: { id: string; chunks: Buffer[]; bytes: number; finishing: boolean } | null =
    null;
  constructor(
    private readonly approve: (transcript: string) => Promise<boolean>,
    private readonly deliver: (audio: Buffer, transcript: string) => void,
    private readonly maxBytes = 3 * 1024 * 1024
  ) {}

  start(id: string): void {
    this.pending = { id, chunks: [], bytes: 0, finishing: false };
  }
  append(id: string, audio: Buffer): boolean {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.finishing) return false;
    if (pending.bytes + audio.length > this.maxBytes || audio.length % 2 !== 0) {
      this.cancel();
      throw new Error('Voice response exceeded audio limits');
    }
    pending.chunks.push(audio);
    pending.bytes += audio.length;
    return true;
  }
  cancel(): void {
    this.pending = null;
  }
  async finish(id: string, transcript: string): Promise<boolean> {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.finishing) return false;
    pending.finishing = true;
    let allowed: boolean;
    try {
      allowed =
        Boolean(transcript.trim()) &&
        transcript.length <= 16000 &&
        pending.bytes > 0 &&
        (await this.approve(transcript));
    } catch {
      allowed = false;
    }
    if (this.pending !== pending) return false;
    this.pending = null;
    if (!allowed) return false;
    this.deliver(Buffer.concat(pending.chunks), transcript);
    return true;
  }
}
