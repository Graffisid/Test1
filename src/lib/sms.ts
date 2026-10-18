/**
 * Sending texts (Twilio Programmable Messaging in reality). SIMULATED here: nothing leaves the machine.
 * A real adapter must keep this contract and return the provider's message id.
 */
import { randomUUID } from "node:crypto";

export interface SmsSender {
  readonly name: string;
  send(toE164: string, body: string): Promise<{ providerMessageId: string; estCostCad: number }>;
}

export class MockSms implements SmsSender {
  readonly name = "mock_twilio_sms";
  async send(): Promise<{ providerMessageId: string; estCostCad: number }> {
    return { providerMessageId: `SMsim${randomUUID().replace(/-/g, "").slice(0, 26)}`, estCostCad: 0.01 };
  }
}
