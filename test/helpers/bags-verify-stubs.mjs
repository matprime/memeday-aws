// Stand-in for @/lib/db, @/lib/cognito and @/lib/rate-limit in the
// bags/verify kill-switch tests, so importing the route needs no AWS
// credentials, Cognito pool or network. Every call is recorded on
// globalThis.__bagsVerifyCalls so a test can assert nothing was touched.
const calls = (globalThis.__bagsVerifyCalls ??= []);
const rec = (name, ret) => async () => {
  calls.push(name);
  return ret;
};

export const getUserIdFromRequest = rec("getUserIdFromRequest", null);
export const getWalletAddressFromRequest = rec("getWalletAddressFromRequest", null);
export const getMemeById = rec("getMemeById", null);
export const getVerifiedBagsTokenForMeme = rec("getVerifiedBagsTokenForMeme", null);
export const getVerifiedBagsTokensByCreator = rec("getVerifiedBagsTokensByCreator", []);
export const createVerifiedBagsToken = rec("createVerifiedBagsToken", null);
export class BagsTokenAlreadyBoundError extends Error {}
export const getClientIp = () => {
  calls.push("getClientIp");
  return "127.0.0.1";
};
export const isRateLimited = rec("isRateLimited", false);
export const rateLimitResponse = () => {
  calls.push("rateLimitResponse");
  return new Response(null, { status: 429 });
};
