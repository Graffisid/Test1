/**
 * A sample callback, for demos: what the phone assistant sounds like. It follows the rules the live agent
 * follows — says it's an assistant, names the business, quotes only the MUSE.md price, and leaves the final
 * confirmation to the owner. Audio (if generated) lives in public/demo-call/<n>.mp3 with a manifest.json.
 */
export interface CallLine { who: "agent" | "customer"; text: string }

export const SAMPLE_CALL: { agentName: string; customerName: string; lines: CallLine[] } = {
  agentName: "Maya (Northshore's assistant)",
  customerName: "Sarah",
  lines: [
    { who: "agent", text: "Hi, is this Sarah?" },
    { who: "customer", text: "Yes, speaking." },
    { who: "agent", text: "Hi Sarah, this is Maya, the virtual assistant at Northshore Plumbing and Heating in Burlington. You asked us to call about a furnace tune-up a minute ago. Is now still an okay time?" },
    { who: "customer", text: "Oh, wow, that was fast. Yeah, sure, go ahead." },
    { who: "agent", text: "Great. You mentioned the furnace started making a noise. Is it more of a rattle, a squeal, or a bang when it kicks on?" },
    { who: "customer", text: "Kind of a rattle, mostly when it first starts up. It's still heating, though." },
    { who: "agent", text: "Okay, that's helpful, thanks. A rattle at start-up is something our tech checks during a tune-up. The tune-up is a hundred and forty-nine dollars plus HST, and it's done by a licensed technician." },
    { who: "customer", text: "That sounds reasonable. When could someone come by?" },
    { who: "agent", text: "I have Monday at ten in the morning, or Monday at noon. Which works better for you?" },
    { who: "customer", text: "Ten works." },
    { who: "agent", text: "Perfect. I've pencilled you in for Monday at ten. Dana, the owner, confirms every booking, so you'll get a text in the next few minutes once it's locked in. Anything else I can help with?" },
    { who: "customer", text: "No, that's everything. Thanks, Maya!" },
    { who: "agent", text: "You're welcome, Sarah. Have a great day!" },
  ],
};
