// FEED#GLOBAL is written asynchronously by the StreamHandler Lambda and read
// through GSI3 (eventually consistent), so the router.refresh() fired right
// after POST /api/memes returns can land before StreamHandler has written the
// new meme. These are the follow-up delays (ms) to refresh again so the feed
// catches up without the caller polling indefinitely.

export const FEED_REFRESH_DELAYS_MS = [1000, 3000, 6000];
