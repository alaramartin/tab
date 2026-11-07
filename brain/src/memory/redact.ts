// Redaction at write time: nothing below reaches memory.db in the clear.

/** Luhn check for 13–19 digit card numbers. */
function luhn(digits: string): boolean {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = digits.charCodeAt(digits.length - 1 - i) - 48;
        if (i % 2 === 1) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
    }
    return sum % 10 === 0;
}

const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const SECRET = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\b0x[0-9a-fA-F]{64}\b/g;

export function redact(s: string): string;
export function redact(s: string | undefined): string | undefined;
export function redact(s: string | undefined): string | undefined {
    if (!s) return s;
    return s
        .replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[card]" : m))
        .replace(SSN, "[ssn]")
        .replace(SECRET, "[secret]");
}
