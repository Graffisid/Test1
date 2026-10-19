/**
 * What each service's sign-in asks for, in plain words. In this build "Connect" opens a practice sign-in screen;
 * the real one replaces it per service once the app is registered with that company (OAuth 2.0 for most).
 * No passwords or tokens for these services are ever typed into or stored by this dashboard.
 */
export interface ConnectorInfo { provider: string; brand: string; signIn: string; asks: string[]; real: string }

export const CONNECTORS: Record<string, ConnectorInfo> = {
  meta: { provider: "Meta", brand: "#1877f2", signIn: "Continue with Facebook",
    asks: ["Publish posts and ads you approve to your Facebook Page and Instagram account", "Read comments and messages on your posts", "See ad results (spend, reach, leads)"],
    real: "Meta Business Login (OAuth 2.0) · app review required before posting" },
  meta_ad_library: { provider: "Meta", brand: "#1877f2", signIn: "Continue with Facebook",
    asks: ["Read the public Ad Library to see which ads competitors run"], real: "Meta Ad Library API (read-only, public data)" },
  tiktok: { provider: "TikTok", brand: "#111111", signIn: "Continue with TikTok",
    asks: ["Post short videos you approve to your TikTok account", "Read comments on your videos"], real: "TikTok Login Kit + Content Posting API (OAuth 2.0)" },
  linkedin: { provider: "LinkedIn", brand: "#0a66c2", signIn: "Sign in with LinkedIn",
    asks: ["Post updates you approve to your company page", "Read comments on those posts"], real: "LinkedIn Community Management API (OAuth 2.0)" },
  twilio: { provider: "Twilio", brand: "#f22f46", signIn: "Connect Twilio account",
    asks: ["Call and text people who asked you to, from your business number", "Receive their replies"], real: "Twilio Connect (OAuth) or a restricted API key in a secret store" },
  whatsapp: { provider: "WhatsApp", brand: "#25d366", signIn: "Connect WhatsApp Business",
    asks: ["Send approval requests to your own WhatsApp number only", "Receive your APPROVE / REJECT replies"], real: "WhatsApp Business via Twilio (approved message templates)" },
  telegram: { provider: "Telegram", brand: "#229ed9", signIn: "Connect Telegram bot",
    asks: ["Send you alerts in a private chat"], real: "Telegram Bot API (bot token in a secret store)" },
  elevenlabs: { provider: "ElevenLabs", brand: "#111111", signIn: "Sign in to ElevenLabs",
    asks: ["Use your voices for callbacks and voiceovers"], real: "ElevenLabs API key in a secret store (paid plan for commercial use)" },
  google_calendar: { provider: "Google", brand: "#1a73e8", signIn: "Sign in with Google",
    asks: ["See when you're free", "Add confirmed visits to your calendar"], real: "Google OAuth 2.0 · calendar.events scope only" },
  calendly: { provider: "Calendly", brand: "#006bff", signIn: "Sign in with Calendly",
    asks: ["Read bookings made on your Calendly page", "Share your booking link with customers"], real: "Calendly OAuth 2.0" },
  trello: { provider: "Trello", brand: "#0c66e4", signIn: "Log in with Atlassian",
    asks: ["Create a card on your job board for each confirmed job"], real: "Trello (Atlassian) OAuth · one board only" },
  anthropic: { provider: "Anthropic", brand: "#d97757", signIn: "Connect Claude",
    asks: ["Use Claude to sort messages, write drafts and analyse your market", "Spend up to your daily AI budget"], real: "Anthropic API key in a secret store, with a daily spend cap" },
  higgsfield: { provider: "Higgsfield", brand: "#6d28d9", signIn: "Sign in to Higgsfield",
    asks: ["Make short videos from approved scripts"], real: "Higgsfield API key in a secret store (paid credits)" },
  image_gen: { provider: "Image generator", brand: "#0e7c86", signIn: "Connect image generator",
    asks: ["Make pictures for approved posts and carousels"], real: "Provider to be chosen with you" },
};
