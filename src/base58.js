const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map(
  [...ALPHABET].map((character, index) => [character, index]),
);

export function decodeBase58(input) {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("Dusk account is empty.");
  let number = 0n;
  for (const character of value) {
    const digit = INDEX.get(character);
    if (digit === undefined)
      throw new Error("Dusk account is not valid base58.");
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number & 0xffn));
    number >>= 8n;
  }
  bytes.reverse();
  let leadingZeroes = 0;
  while (value[leadingZeroes] === "1") leadingZeroes += 1;
  return Uint8Array.from([...new Array(leadingZeroes).fill(0), ...bytes]);
}

export function encodeBase58(bytes) {
  const input = Uint8Array.from(bytes ?? []);
  let number = 0n;
  for (const byte of input) number = (number << 8n) + BigInt(byte);
  let out = "";
  while (number > 0n) {
    out = ALPHABET[Number(number % 58n)] + out;
    number /= 58n;
  }
  let leadingZeroes = 0;
  while (input[leadingZeroes] === 0) leadingZeroes += 1;
  return "1".repeat(leadingZeroes) + out;
}
