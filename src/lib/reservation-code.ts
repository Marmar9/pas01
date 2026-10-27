import { randomInt } from "node:crypto";

// Excludes ambiguous characters (0/O, 1/I) so codes are easy to read out loud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export function generateReservationCode(length = CODE_LENGTH): string {
  let code = "";

  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }

  return code;
}
