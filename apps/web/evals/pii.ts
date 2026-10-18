/**
 * Fixture hygiene: evaluation contracts and model outputs are invented. These detectors catch the
 * common ways real personal data slips in. Allowed placeholders are RFC 2606 example domains and
 * reserved TLDs, and the fictional North American 555-0100 to 555-0199 telephone range.
 */
export type PiiKind = "email" | "card" | "iban" | "ssn" | "phone";
export type PiiFinding = { kind: PiiKind; match: string };

const ALLOWED_EMAIL_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|net|org)|[a-z0-9-]+\.(?:example|test|invalid|localhost))$|^(?:example|test|invalid|localhost)$/;

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function ibanValid(candidate: string): boolean {
  const rearranged = candidate.slice(4) + candidate.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value)
      remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const fictionalLine = (exchange: string, line: string) =>
  exchange === "555" && /^01\d\d$/.test(line);

export function findPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];

  for (const [match, domain] of text.matchAll(
    /[\p{L}\p{N}._%+-]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/gu,
  )) {
    if (!ALLOWED_EMAIL_DOMAIN.test(domain!.toLowerCase())) {
      findings.push({ kind: "email", match });
    }
  }

  for (const [match] of text.matchAll(
    /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
  )) {
    const digits = match.replace(/\D/g, "");
    if (digits.length >= 13 && luhnValid(digits)) {
      findings.push({ kind: "card", match });
    }
  }

  // The pattern is greedy and can run into following capitals, so test every IBAN-length prefix.
  for (const [match] of text.matchAll(
    /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}/g,
  )) {
    const compact = match.replace(/ /g, "");
    for (let length = Math.min(34, compact.length); length >= 15; length -= 1) {
      if (ibanValid(compact.slice(0, length))) {
        findings.push({ kind: "iban", match });
        break;
      }
    }
  }

  for (const [match] of text.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)) {
    findings.push({ kind: "ssn", match });
  }

  // North American numbers with an area code, then seven-digit local numbers.
  const nanp =
    /(?:\+?1[\s.-]?)?(?:\((\d{3})\)|\b(\d{3}))[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;
  const covered: Array<[number, number]> = [];
  for (const match of text.matchAll(nanp)) {
    covered.push([match.index, match.index + match[0].length]);
    if (!fictionalLine(match[3]!, match[4]!)) {
      findings.push({ kind: "phone", match: match[0] });
    }
  }
  for (const match of text.matchAll(/\b(\d{3})[-.](\d{4})\b/g)) {
    const inside = covered.some(
      ([start, end]) => match.index >= start && match.index < end,
    );
    if (!inside && !fictionalLine(match[1]!, match[2]!)) {
      findings.push({ kind: "phone", match: match[0] });
    }
  }
  // Any other country code: there is no reserved fictional range to allow.
  for (const [match] of text.matchAll(
    /\+(?:[2-9]\d{0,2})[\s.-]?\d(?:[\s.-]?\d){6,13}/g,
  )) {
    findings.push({ kind: "phone", match });
  }

  return findings;
}
