/**
 * Sending WhatsApp messages to the OWNER (Twilio's WhatsApp API in reality). SIMULATED here: nothing leaves
 * the machine. Only the owner's own number is ever messaged — customers are never contacted on WhatsApp.
 * A real adapter must keep this contract and return the provider's message id.
 */
import { randomUUID } from "node:crypto";

export interface WhatsAppSender {
  readonly name: string;
  send(toE164: string, body: string): Promise<{ providerMessageId: string; estCostCad: number }>;
}

const sid = () => `WAsim${randomUUID().replace(/-/g, "").slice(0, 26)}`;

/** Keeps what it "sent" in memory — for tests and the CLI. */
export class MockWhatsApp implements WhatsAppSender {
  readonly name = "mock_twilio_whatsapp";
  readonly sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
    return { providerMessageId: sid(), estCostCad: 0.01 };
  }
}

/**
 * Sandbox only: hands the message to the pretend phone (src/demo/server.ts) over loopback, with a shared
 * secret, so the owner's WhatsApp screen there shows it. If the pretend phone is down, the message is still
 * recorded as sent — exactly like a real phone that is switched off.
 */
export class DemoPhoneWhatsApp implements WhatsAppSender {
  readonly name = "demo_phone_whatsapp";
  constructor(private readonly base: string, private readonly secret: string) {
    const u = new URL(base);
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error("The demo phone must be on this machine (127.0.0.1).");
  }
  async send(to: string, body: string) {
    const id = sid();
    try {
      await fetch(`${this.base.replace(/\/$/, "")}/_deliver`, {
        method: "POST", signal: AbortSignal.timeout(3000),
        headers: { "content-type": "application/json", "x-demo-secret": this.secret },
        body: JSON.stringify({ id, to, body }),
      });
    } catch { /* phone "off" — the message stays recorded */ }
    return { providerMessageId: id, estCostCad: 0.01 };
  }
}
