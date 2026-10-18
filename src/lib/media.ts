/**
 * Media providers for media-producer: product-photo → video (Higgsfield) and voiceover (ElevenLabs).
 * Both are paid per generation in reality; this build ships simulators only. Real adapters need the
 * owner's accounts and must keep the same contract (and the same cost reporting).
 */
export interface MediaRequest { variantId: string; script: string; voiceId?: string }
export interface MediaResult { ok: boolean; url?: string; estCostCad: number; error?: string }

export interface MediaProvider {
  readonly name: string;
  readonly kind: "video" | "voiceover";
  readonly estCostCad: number;     // estimate per generation, checked against the batch threshold first
  generate(req: MediaRequest): Promise<MediaResult>;
}

/** Fictional voice ids — each variant of an ad gets a different one (MUSE.md / source system). */
export const MOCK_VOICES = ["mock_voice_maple", "mock_voice_harbour", "mock_voice_ridge", "mock_voice_lakeshore",
  "mock_voice_cedar", "mock_voice_escarpment"] as const;

export class MockVideoProvider implements MediaProvider {
  readonly name = "mock_higgsfield";
  readonly kind = "video" as const;
  readonly estCostCad = 1.5;
  constructor(private readonly failFor: Set<string> = new Set()) {}
  async generate(req: MediaRequest): Promise<MediaResult> {
    if (this.failFor.has(req.variantId)) return { ok: false, estCostCad: 0, error: "simulated generation failure" };
    return { ok: true, url: `mock://media/video/${req.variantId}.mp4`, estCostCad: this.estCostCad };
  }
}

export class MockVoiceProvider implements MediaProvider {
  readonly name = "mock_elevenlabs";
  readonly kind = "voiceover" as const;
  readonly estCostCad = 0.3;
  constructor(private readonly failFor: Set<string> = new Set()) {}
  async generate(req: MediaRequest): Promise<MediaResult> {
    if (this.failFor.has(req.variantId)) return { ok: false, estCostCad: 0, error: "simulated generation failure" };
    return { ok: true, url: `mock://media/voice/${req.variantId}-${req.voiceId}.mp3`, estCostCad: this.estCostCad };
  }
}
