export function getRelayInfoDocument(minSeq?: number): object {
  return {
    name: "nostr-relay-bun",
    description: "A NIP-01 Nostr relay built on Bun",
    pubkey: "",
    contact: "",
    supported_nips: [1, 9, 11, 23, 42, 59, "CF"],
    software: "nostr-relay-bun",
    version: "0.1.0",
    changes_feed: {
      min_seq: minSeq ?? 0,
    },
  }
}
