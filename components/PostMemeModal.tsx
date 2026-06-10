"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { X, Upload, Zap, Loader2 } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { createBagsProject, createBagsToken } from "@/lib/bags";
import { mintMemeNft } from "@/lib/nft";

interface Props {
  onClose: () => void;
}

export function PostMemeModal({ onClose }: Props) {
  const router = useRouter();
  const wallet = useWallet();
  const { publicKey } = wallet;
  const { cognitoToken, addToast, emitBagsEvent, myBagsProjectId, myTokenSymbol, setMyBagsProject } =
    useAppStore();

  const [caption, setCaption] = useState("");
  const [isNFT, setIsNFT] = useState(false);
  const [nftPrice, setNftPrice] = useState("0.01");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"form" | "uploading" | "minting" | "creating">("form");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasCreatorToken = !!myBagsProjectId;

  useEffect(() => {
    if (!selectedImage) { setImagePreviewUrl(""); return; }
    const objectUrl = URL.createObjectURL(selectedImage);
    setImagePreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedImage]);

  const handleFile = (file: File | null) => {
    if (!file) return;
    const validTypes = ["image/png", "image/jpeg", "image/gif"];
    if (!validTypes.includes(file.type)) {
      addToast("Please upload a PNG, JPG, or GIF image.", "error");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      addToast("Image is too large. Maximum size is 10MB.", "error");
      return;
    }
    setSelectedImage(file);
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    handleFile(event.target.files?.[0] ?? null);
    event.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFile(e.dataTransfer.files?.[0] ?? null);
  };

  const uploadImage = async (file: File): Promise<{ s3Key: string; imageUrl: string }> => {
    const ext = file.name.split(".").pop() ?? "jpg";
    const urlRes = await fetch(`/api/upload-url?ext=${ext}`, {
      headers: { Authorization: `Bearer ${cognitoToken}` },
    });
    if (!urlRes.ok) throw new Error("Failed to get upload URL");
    const { presignedUrl, s3Key, imageUrl } = await urlRes.json();
    const putRes = await fetch(presignedUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type },
    });
    if (!putRes.ok) throw new Error("Image upload failed");
    return { s3Key, imageUrl };
  };

  const handleSubmit = async () => {
    if (!cognitoToken || !caption.trim() || !selectedImage) return;
    setLoading(true);

    try {
      const walletAddress = publicKey?.toBase58() ?? "";

      // 1. Upload image to S3 via presigned URL
      setStep("uploading");
      const { s3Key, imageUrl } = await uploadImage(selectedImage);

      // 2. Mint NFT on Solana devnet (Phantom will prompt for signature)
      let mintAddress: string | null = null;
      if (isNFT) {
        setStep("minting");
        mintAddress = await mintMemeNft(wallet, walletAddress, imageUrl, caption.trim());
        addToast("NFT minted on Solana!", "success");
      }

      // 3. Bags project/token for first-time creators
      setStep("creating");
      let projectId = myBagsProjectId;
      let symbol = myTokenSymbol;

      if (!hasCreatorToken && tokenSymbol) {
        const project = await createBagsProject(walletAddress, caption.slice(0, 20));
        projectId = project.projectId;
        emitBagsEvent({ type: "project_created", projectId: project.projectId });
        addToast(`Creator project created on Bags (${project.projectId.slice(0, 12)}…)`, "bags");

        const token = await createBagsToken(project.projectId, `${tokenSymbol} Token`, tokenSymbol);
        symbol = token.symbol;
        emitBagsEvent({ type: "token_created", symbol: token.symbol, projectId: project.projectId });
        addToast(`Creator token $${token.symbol} is live on Bags!`, "bags");
        setMyBagsProject(project.projectId, token.symbol);
      }

      // 4. Upsert user record
      await fetch("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cognitoToken}`,
        },
        body: JSON.stringify({ walletAddr: walletAddress || undefined, bagsProjectId: projectId }),
      });

      // 5. Save meme to DB
      const res = await fetch("/api/memes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cognitoToken}`,
        },
        body: JSON.stringify({
          s3Key,
          caption: caption.trim(),
          isNFT,
          nftMint: mintAddress ?? undefined,
          listingPrice: isNFT ? parseFloat(nftPrice) : undefined,
        }),
      });

      if (!res.ok) throw new Error("Failed to save meme");

      addToast(`Meme posted! "${caption.slice(0, 30)}…"`, "success");
      router.refresh();
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to post meme.", "error");
    } finally {
      setLoading(false);
      setStep("form");
    }
  };

  const stepLabel =
    step === "uploading" ? "Uploading image…" :
    step === "minting" ? "Minting NFT on Solana… (approve in Phantom)" :
    "Creating on Bags & posting…";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-2xl w-full max-w-lg animate-slide-up shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-surface z-10">
          <h2 className="font-bold text-white text-lg">Post a Meme</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif"
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`w-full border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors group ${isDragging ? "border-accent bg-accent/10" : "border-border hover:border-accent/50"}`}
          >
            {imagePreviewUrl ? (
              <div className="space-y-3">
                <img
                  src={imagePreviewUrl}
                  alt="Selected meme preview"
                  className="mx-auto max-h-56 w-auto rounded-lg object-contain"
                />
                <p className="text-xs text-gray-400">
                  {selectedImage?.name} — click to choose another
                </p>
              </div>
            ) : (
              <>
                <Upload size={28} className="mx-auto text-gray-500 group-hover:text-accent-light mb-2 transition-colors" />
                <p className="text-sm text-gray-400">
                  Drop your meme here or <span className="text-accent-light">browse</span>
                </p>
                <p className="text-xs text-gray-600 mt-1">PNG, JPG, GIF up to 10MB</p>
              </>
            )}
          </button>

          <div>
            <label className="text-xs text-gray-400 mb-1.5 block font-medium">Caption *</label>
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="When your transaction confirms before your eyes open…"
              className="w-full bg-bg/60 border border-border rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-accent placeholder:text-gray-600"
            />
          </div>

          <div className="flex items-center justify-between bg-bg/60 border border-border/50 rounded-xl px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-white">Mint as NFT</p>
              <p className="text-xs text-gray-500">Set a price and earn from sales</p>
            </div>
            <button
              onClick={() => setIsNFT(!isNFT)}
              className={`w-11 h-6 rounded-full transition-colors relative ${isNFT ? "bg-accent" : "bg-gray-700"}`}
            >
              <span
                className={`absolute top-0.5 left-0 w-5 h-5 bg-white rounded-full shadow transition-transform ${isNFT ? "translate-x-5" : "translate-x-0.5"}`}
              />
            </button>
          </div>

          {isNFT && (
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block font-medium">NFT Price (SOL)</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={nftPrice}
                onChange={(e) => setNftPrice(e.target.value)}
                className="w-full bg-bg/60 border border-border rounded-xl px-4 py-3 text-white font-mono focus:outline-none focus:border-accent"
              />
            </div>
          )}

          {!hasCreatorToken && (
            <div className="bg-bags/10 border border-bags/30 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Zap size={16} className="text-bags" />
                <p className="text-sm font-bold text-bags">Launch Your Creator Token on Bags</p>
              </div>
              <p className="text-xs text-gray-400 mb-3">
                First-time creators automatically get a Bags project and a fungible creator token. Fans can invest in you directly.
              </p>
              <label className="text-xs text-gray-400 mb-1.5 block font-medium">
                Token Symbol (2-6 chars, e.g. MLRD)
              </label>
              <input
                type="text"
                value={tokenSymbol}
                onChange={(e) => setTokenSymbol(e.target.value.toUpperCase().slice(0, 6))}
                placeholder="MYTKN"
                maxLength={6}
                className="w-full bg-bg/80 border border-bags/30 rounded-xl px-4 py-3 text-white font-mono focus:outline-none focus:border-bags placeholder:text-gray-600"
              />
            </div>
          )}

          {hasCreatorToken && (
            <div className="flex items-center gap-2 bg-green-900/20 border border-green-700/30 rounded-xl px-4 py-2.5 text-sm text-green-400">
              <Zap size={14} />
              Creator token ${myTokenSymbol} active on Bags
            </div>
          )}
        </div>

        <div className="p-5 pt-0">
          {loading ? (
            <div className="w-full py-3.5 rounded-xl bg-bags/20 border border-bags/30 flex items-center justify-center gap-2 text-bags font-semibold">
              <Loader2 size={18} className="animate-spin" />
              {stepLabel}
            </div>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!caption.trim() || !selectedImage || !cognitoToken}
              className="w-full py-3.5 rounded-xl font-bold text-white bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              Post Meme{!hasCreatorToken && tokenSymbol ? " & Launch Token" : ""}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
