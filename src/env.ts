const SECRET_KEY_MINIMUM_LENGTH = 44;

// oxlint-disable-next-line typescript/dot-notation
const secretKey = process.env["SECRET_KEY"];

if (typeof secretKey !== "string") {
  throw new Error("SECRET_KEY is required");
}

if (secretKey.length < SECRET_KEY_MINIMUM_LENGTH) {
  throw new Error(
    `SECRET_KEY is too short, received: ${secretKey.length}, expected: ${SECRET_KEY_MINIMUM_LENGTH}`,
  );
}

export const SECRET_KEY = secretKey;
