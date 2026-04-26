// Public CC collection identifiers — partner apps don't need to keep these
// secret; anyone can query Helius DAS for NFTs in these groupings.
export const CC_COLLECTIONS = {
  // Standard pNFT / Metaplex Token Metadata collection
  metaplex: 'CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf',
  // Metaplex Core (mpl-core) collection
  core: 'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac',
} as const;

export interface CcAsset {
  /** The DAS asset id — the value to pass into `nftAddresses` for
   * `/redeem/prepare`. For Solana standard NFTs this is the mint; for cNFTs
   * it's the asset id. CC's backend treats both as `Card.nftAddress`. */
  id: string;
  name: string;
  imageUrl?: string;
  compressed: boolean;
  collection: 'metaplex' | 'core';
}

interface DasAssetItem {
  id: string;
  content?: {
    metadata?: { name?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string; cdn_uri?: string }>;
  };
  compression?: { compressed?: boolean };
}

interface DasSearchResponse {
  result?: { items: DasAssetItem[] };
  error?: { message?: string };
}

async function searchAssets(
  apiKey: string,
  ownerAddress: string,
  collectionAddress: string,
): Promise<DasSearchResponse> {
  const res = await fetch(
    `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'cc-partner-test',
        method: 'searchAssets',
        params: {
          ownerAddress,
          grouping: ['collection', collectionAddress],
          limit: 1000,
          page: 1,
        },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Helius ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as DasSearchResponse;
}

function pickImage(item: DasAssetItem): string | undefined {
  return (
    item.content?.links?.image ??
    item.content?.files?.[0]?.cdn_uri ??
    item.content?.files?.[0]?.uri
  );
}

export async function fetchCcAssets(
  apiKey: string,
  ownerAddress: string,
): Promise<CcAsset[]> {
  const [metaplex, core] = await Promise.all([
    searchAssets(apiKey, ownerAddress, CC_COLLECTIONS.metaplex),
    searchAssets(apiKey, ownerAddress, CC_COLLECTIONS.core),
  ]);

  const out: CcAsset[] = [];
  for (const item of metaplex.result?.items ?? []) {
    out.push({
      id: item.id,
      name: item.content?.metadata?.name ?? item.id,
      imageUrl: pickImage(item),
      compressed: !!item.compression?.compressed,
      collection: 'metaplex',
    });
  }
  for (const item of core.result?.items ?? []) {
    out.push({
      id: item.id,
      name: item.content?.metadata?.name ?? item.id,
      imageUrl: pickImage(item),
      compressed: !!item.compression?.compressed,
      collection: 'core',
    });
  }
  return out;
}
