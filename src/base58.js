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
