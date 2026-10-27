import { customAlphabet } from "nanoid";

// Excludes ambiguous characters (0/O, 1/I) so codes are easy to read out loud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export const generateReservationCode = customAlphabet(
  CODE_ALPHABET,
  CODE_LENGTH,
);
