/** North American (NANP) phone numbers → E.164 (+1XXXXXXXXXX). Returns null if not a valid NANP number. */
export function toE164(input: string): string | null {
  const digits = input.replace(/[^\d]/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null; // area code and exchange can't start with 0/1
  return `+1${ten}`;
}

export function formatNanp(e164: string): string {
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
