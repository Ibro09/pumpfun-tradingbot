const TelegramBot = require("node-telegram-bot-api");
const web3 = require("@solana/web3.js");
const bip39 = require("bip39");
const ed25519 = require("ed25519-hd-key");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const { Headers } = fetch;
const myHeaders = new Headers();
const {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} = require("@solana/web3.js");
const bs58 = require("bs58").default;
const axios = require("axios");
const { swapBaseInAutoAccount } = require("@raydium-io/raydium-sdk-v2");
require("dotenv").config();

// Replace with your MongoDB URI
const MONGODB_URI = process.env.MONGODB_URI;
// Connect to MongoDB
mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("✅ MongoDB connected");
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
  });

// Wallet schema
const walletSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  privateKey: String,
  address: String,
  tokensBought: { type: Number, default: 0 },
});
const tokensBoughtSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  walletAddress: { type: String, required: true },
  mintAddress: { type: String, required: true },
  amount: { type: Number, required: true },
  priceInUSD: { type: Number, required: true },
  txId: { type: String },
  timestamp: { type: Date, default: Date.now },
});

const TokensBoughtModel = mongoose.model("TokensBought", tokensBoughtSchema);

const WalletModel = mongoose.model("Wallet", walletSchema);

//  bot token
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const pendingDeletions = {};

// Create or return a wallet
async function createWallet(userId) {
  let wallet = await WalletModel.findOne({ userId });
  if (wallet) return wallet;

  const mnemonic = bip39.generateMnemonic();
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const derivedSeed = ed25519.derivePath(
    "m/44'/501'/0'/0'",
    seed.toString("hex")
  ).key;
  const keypair = web3.Keypair.fromSeed(derivedSeed);

  const privateKey = Buffer.from(keypair.secretKey).toString("hex");
  const address = keypair.publicKey.toBase58();

  wallet = new WalletModel({
    userId,
    privateKey,
    address,
    tokensBought: 0,
  });

  await wallet.save();
  console.log("✅ New wallet saved:", address);
  return wallet;
}
// Decode hex private key to Uint8Array and JSON array
function decodeHexPrivateKey(hexPrivateKey) {
  const privateKeyBytes = Buffer.from(hexPrivateKey, "hex");
  return {
    uint8Array: privateKeyBytes,
    jsonArray: Array.from(privateKeyBytes),
  };
}

async function amountInSol() {
  const myHeaders = new Headers();
  myHeaders.append("Content-Type", "application/json");
  myHeaders.append(
    "Authorization",
    process.env.QUERY_TOKEN // Replace with your Bitquery API key
  );

  const query = `
    query {
      Solana {
        DEXTradeByTokens(
          orderBy: { descending: Block_Time }
          where: {
            Trade: {
              Currency: { MintAddress: { is: "So11111111111111111111111111111111111111112" } }
              Side: {
                Currency: { MintAddress: { is: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } }
              }
            }
          }
          limit: { count: 1 }
        ) {
          Block {
            Time
          }
          Trade {
            PriceInUSD
          }
        }
      }
    }
  `;

  const raw = JSON.stringify({ query, variables: {} });

  const requestOptions = {
    method: "POST",
    headers: myHeaders,
    body: raw,
    redirect: "follow",
  };

  try {
    const response = await fetch(
      "https://streaming.bitquery.io/eap",
      requestOptions
    );
    const data = await response.json();
    const price = data?.data?.Solana?.DEXTradeByTokens?.[0]?.Trade?.PriceInUSD;

    if (price) {
      const solFor10USD = 10 / price;
      return solFor10USD;
    } else {
      throw new Error("Price not found in response");
    }
  } catch (error) {
    console.error("Error fetching SOL price:", error);
    throw error;
  }
}

async function handleSell(chatId, userId, outputMint) {
  try {
    console.log("🔑 Fetching wallet...");
    const wallet = await WalletModel.findOne({ userId });
    const SECRET_KEY = decodeHexPrivateKey(
      wallet.privateKey.toString()
    ).jsonArray;
    const keypair = Keypair.fromSecretKey(Uint8Array.from(SECRET_KEY));
    const connection = new Connection(
      "https://api.mainnet-beta.solana.com",
      "confirmed"
    );

    const inputMint = outputMint;
    const outputMintSOL = "So11111111111111111111111111111111111111112";

    console.log("🔍 Getting token balance...");
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { mint: new PublicKey(inputMint) }
    );

    const uiAmount =
      tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount
        ?.uiAmount;
    console.log("✅ Token balance (UI Amount):", uiAmount);

    if (!uiAmount || uiAmount <= 0) {
      console.log("❌ No balance found for this token.");
      return bot.sendMessage(chatId, `❌ You have no balance for ${inputMint}`);
    }

    const tokenInfo =
      tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount;
    const decimals = tokenInfo?.decimals || 9; // Default fallback
    const amount = Math.floor(uiAmount * Math.pow(10, decimals));
    console.log(`🧮 Token decimals: ${decimals}`);
    console.log("🧮 Token amount in smallest unit:", amount);

    const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMintSOL}&amount=${amount}&slippageBps=100&dynamicSlippage=true`;
    console.log("🌐 Fetching quote from Jupiter...");
    const quoteRes = await fetch(quoteUrl);

    if (!quoteRes.ok) {
      const errText = await quoteRes.text();
      console.log("❌ Quote API failed:", errText);
      throw new Error(`Quote API failed (${quoteRes.status}): ${errText}`);
    }

    const quoteResponse = await quoteRes.json();

    console.log("⚙️ Building swap transaction...");
    const swapRes = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapUnwrapSOL: true,
        dynamicSlippage: true,
      }),
    });

    const swapJson = await swapRes.json();
    console.log(
      "✅ Swap response received:",
      JSON.stringify(swapJson, null, 2)
    );

    if (!swapJson.swapTransaction) {
      console.log("❌ No swapTransaction found.");
      throw new Error("No swapTransaction returned.");
    }

    // 4. Sign & send
    const txBuffer = Buffer.from(swapJson.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([keypair]);

    const signed = transaction.serialize();
    const txid = await connection.sendRawTransaction(signed, {
      skipPreflight: false,
    });
    console.log(`🚀 Sent: ${txid}`);
    console.log(`🔗 https://solscan.io/tx/${txid}`);

    const confirmation = await connection.confirmTransaction(txid, "finalized");
    console.log(`✅ Swap confirmed for ${outputMint}`);

    console.log(`✅ Transaction confirmed: https://solscan.io/tx/${txid}`);
    bot.sendMessage(
      chatId,
      `✅ Token sold successfully!\n🔗 https://solscan.io/tx/${txid}`
    );
  } catch (err) {
    console.error("❌ Error selling token:", err.message);
    bot.sendMessage(
      chatId,
      `❌ Failed to sell token: ${outputMint}\nError: ${err.message}`
    );
  }
}

amountInSol()
  .then((solAmount) => {
    console.log(`You get ~${solAmount.toFixed(6)} SOL for $10`);
  })
  .catch((error) => {
    console.error("Failed to get SOL amount:", error.message);
  });

// /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const wallet = await createWallet(userId);

  bot.sendMessage(
    chatId,
    `Welcome to the Demo Token Bot!
To get started:
- Use /buy to buy your first 10 tokens.
- Use /pnl to check your token profits.
- Use /wallet to get your private key .
- Use /balance to get your wallet balance .
- Use /deletewallet to delete wallet parmanently.

Your new wallet address is (tap to copy):
\n\`${wallet.address}\``,
    { parse_mode: "Markdown" }
  );
});

// /buy command
bot.onText(/\/buy/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  bot.sendMessage(chatId, "Fetching latest tokens...");
  const wallet = await WalletModel.findOne({ userId });

  try {
    const SECRET_KEY = decodeHexPrivateKey(
      wallet.privateKey.toString()
    ).jsonArray;

    const keypair = Keypair.fromSecretKey(Uint8Array.from(SECRET_KEY));
    const connection = new Connection(
      "https://api.mainnet-beta.solana.com",
      "confirmed"
    );

    const inputMint = "So11111111111111111111111111111111111111112"; // Native SOL

    const newamount = await amountInSol();

    const amount = Math.ceil(Number(newamount) * 1e9) || 0; // Convert to lamports (1 SOL = 1e9 lamports)
    // const amount = 150000; // Convert to lamports (1 SOL = 1e9 lamports)
    console.log(`💰 Amount to swap: ${amount} lamports (${newamount} SOL)`);

    // 1. Fetch Pump tokens launched in last 10 minutes from Bitquery
    const now = new Date();
    const tenMinutesAgo = new Date(
      now.getTime() - 10 * 60 * 1000
    ).toISOString();
    const query = `
{
  Solana {
    DEXTrades(
      limitBy: {by: Trade_Buy_Currency_MintAddress, count: 1}
      limit: {count: 5}
      orderBy: {ascending: Block_Time}
      where: {
        Trade: {
          Dex: {ProtocolName: {is: "pump"}},
          Buy: {
            Currency: {MintAddress: {notIn: ["11111111111111111111111111111111"]}},
            PriceInUSD: {gt: 0.00001}
          },
          Sell: {AmountInUSD: {gt: "10"}}
        },
        Transaction: {Result: {Success: true}}
      }
    ) {
      Block {
        Time
      }
      Transaction {
        Signer
        Signature
      }
      Trade {
        Buy {
          Price(maximum: Block_Time)
          PriceInUSD(maximum: Block_Time)
          Currency {
            Name
            Symbol
            MintAddress
            Decimals
            Fungible
            Uri
          }
        }
        Market {
          MarketAddress
        }
      }
      joinTokenSupplyUpdates(
        TokenSupplyUpdate_Currency_MintAddress: Trade_Buy_Currency_MintAddress
        join: inner
        where: {
          Instruction: {
            Program: {
              Name: {is: "pump"},
              Method: {is: "create"}
            }
          },
          Block: {
            Time: {since: "${tenMinutesAgo}"}
          }
        }
      ) {
        Block {
          Time
        }
        Transaction {
          Dev: Signer
          Signature
        }
      }
    }
  }
}`;

    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: process.env.QUERY_TOKEN,
      },
      body: JSON.stringify({ query }),
    };
    (async () => {
      try {
        const res = await fetch(
          "https://streaming.bitquery.io/eap",
          requestOptions
        );

        const json = await res.json();

        const tokens = (json?.data?.Solana?.DEXTrades || [])
          .map((t) => ({
            mintAddress: t?.Trade?.Buy?.Currency?.MintAddress,
            priceInUSD: t?.Trade?.Buy?.PriceInUSD,
          }))
          .filter((t) => t.mintAddress);

        console.log(tokens);

        console.log(`🪙 Found ${tokens.length} tokens:`);

        bot.sendMessage(
          chatId,
          `🪙 Found ${tokens.length} tokens. Buying tokens...`
        );
        for (const token of tokens) {
          const { mintAddress: outputMint, priceInUSD: bitqueryUSDPrice } =
            token;

          console.log(`\n🔄 Swapping SOL for token: ${outputMint}`);
          try {
            // 2. Get Quote from Jupiter
            const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Number(
              amount
            )}&slippageBps=100&dynamicSlippage=true`;
            const quoteResponse = await (await fetch(quoteUrl)).json();
            console.log("✅ Quote response received:", quoteResponse);

            if (!quoteResponse || !quoteResponse.outAmount) {
              throw new Error("Invalid quote response");
            }

            console.log("✅ Quote fetched:", quoteResponse.outAmount);

            // 3. Get swap transaction
            const swapRes = await fetch(
              "https://lite-api.jup.ag/swap/v1/swap",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  quoteResponse,
                  userPublicKey: keypair.publicKey.toBase58(),
                  wrapUnwrapSOL: true,
                  dynamicSlippage: true,
                }),
              }
            );

            const swapJson = await swapRes.json();
            if (!swapJson.swapTransaction)
              throw new Error("No swap transaction");

            console.log("✅ Swap transaction received");

            // 4. Sign & send
            const txBuffer = Buffer.from(swapJson.swapTransaction, "base64");
            const transaction = VersionedTransaction.deserialize(txBuffer);
            transaction.sign([keypair]);

            const signed = transaction.serialize();
            const txid = await connection.sendRawTransaction(signed, {
              skipPreflight: false,
            });
         
            console.log(`🚀 Sent: ${txid}`);
            console.log(`🔗 https://solscan.io/tx/${txid}`); 

            const confirmation = await connection.confirmTransaction(
              txid,
              "finalized"
            );
            console.log(`✅ Swap confirmed for ${outputMint}`);
            // ✅ Save bought token
            await TokensBoughtModel.create({
              userId,
              walletAddress: keypair.publicKey.toBase58(),
              mintAddress: outputMint,
              amount: parseFloat(quoteResponse.outAmount) / Math.pow(10, 9),
              priceInUSD: bitqueryUSDPrice || quoteResponse.outAmountInUSD || 0,
              txId: txid,
            });

            bot.sendMessage(
              chatId,
              `✅ Successfully bought token: ${outputMint}\n🔗 https://solscan.io/tx/${txid}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "💸 Sell Token",
                        callback_data: `sell_${outputMint}`,
                      },
                    ],
                  ],
                },
              }
            );
          } catch (err) {
            console.error(`❌ Error swapping ${outputMint}:`, err.message);
            bot.sendMessage(
              chatId,
              `❌ Failed to swap for token: ${outputMint}`
            );
          }
        }
      } catch (error) {
        console.error("❌ Bitquery fetch error:", error.message);
        bot.sendMessage(chatId, "❌ Failed to fetch token data.");
      }
    })();
  } catch (err) {
    console.error("Error fetching data:", err);
    bot.sendMessage(chatId, "❌ Failed to fetch token data.");
  }
});

// /pnl command
bot.onText(/\/pnl/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const tokens = await TokensBoughtModel.find({ userId });

  if (tokens.length === 0) {
    return bot.sendMessage(chatId, "❌ No tokens bought yet.");
  }

  let response = "📦 Tokens Bought:\n\n";

  for (const [i, token] of tokens.entries()) {
    const { mintAddress, amount, priceInUSD: buyPrice, txId } = token;

    try {
      const query = {
        query: `
          query LatestTokenPrice {
            Solana {
              DEXTradeByTokens(
                orderBy: { descending: Block_Time }
                limit: { count: 1 }
                where: {
                  Trade: {
                    Currency: { MintAddress: { is: "${mintAddress}" } }
                  }
                  Transaction: { Result: { Success: true } }
                }
              ) {
                Trade {
                  PriceInUSD
                  Currency {
                    Symbol
                    Name
                  }
                  Dex {
                    ProtocolName
                  }
                }
              }
            }
          }
        `,
      };

      const res = await fetch("https://streaming.bitquery.io/eap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: process.env.QUERY_TOKEN,
        },
        body: JSON.stringify(query),
      });

      const json = await res.json();
      const tradeInfo = json?.data?.Solana?.DEXTradeByTokens?.[0]?.Trade;

      if (!tradeInfo) {
        response += `${
          i + 1
        }. Mint: \`${mintAddress}\`\n   Amount: ${amount}\n   Price: $${buyPrice}\n   ❌ Failed to fetch current price\n   🔗 https://solscan.io/tx/${txId}\n\n`;
        continue;
      }

      const currentPrice = tradeInfo.PriceInUSD;
      const tokenName = tradeInfo.Currency?.Name || "Unknown";
      const tokenSymbol = tradeInfo.Currency?.Symbol || "";
      const pnl = (currentPrice - buyPrice) * amount;
      const pnlPercent = ((currentPrice - buyPrice) / buyPrice) * 100;

      response += `${i + 1}. ${tokenName} $${tokenSymbol} ${
        pnl >= 0 ? "📈" : "📉"
      }  (${pnlPercent.toFixed(2)}%)\n\n   
      Mint: \`${mintAddress}\`\n\n    
      Buy Price: $${buyPrice.toFixed(6)}\n   
       Current: $${currentPrice.toFixed(6)}\n \n    
      🔗 https://solscan.io/tx/${txId}\n\n`;
    } catch (err) {
      console.error("Error fetching token price:", err.message);
      response += `${
        i + 1
      }. Mint: \`${mintAddress}\`\n   Amount: ${amount}\n   Price: $${buyPrice}\n   ❌ Error fetching current price\n   🔗 https://solscan.io/tx/${txId}\n\n`;
    }
  }

  bot.sendMessage(chatId, response, { parse_mode: "Markdown" });

  const count = await TokensBoughtModel.countDocuments({ userId });
  bot.sendMessage(chatId, `🪙 You have bought ${count} tokens so far.`);
});

// /wallet command
bot.onText(/\/wallet/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const wallet = await WalletModel.findOne({ userId });
  if (!wallet) {
    return bot.sendMessage(
      chatId,
      "User has no wallet yet. Click /start to create one."
    );
  }

  bot.sendMessage(
    chatId,
    `Your private key (tap to copy):\n\`${wallet.privateKey}\``,
    {
      parse_mode: "Markdown",
    }
  );
});

const connection = new Connection("https://api.mainnet-beta.solana.com");

// /balance command
bot.onText(/\/balance/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const walletarray = await WalletModel.findOne({ userId });
  const wallet = walletarray.address;

  try {
    const pubkey = new PublicKey(wallet);

    // Get SOL balance
    const lamports = await connection.getBalance(pubkey);
    const solBalance = lamports / 1e9;

    // Get token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      pubkey,
      {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      }
    );

    let response = `💰 Balance SOL: ${solBalance.toFixed(4)} SOL\n`;

    if (tokenAccounts.value.length === 0) {
      response += "🔸 No SPL tokens found.";
    } else {
      response += "\n📦 SPL Tokens:\n";
      for (const { account } of tokenAccounts.value) {
        const { mint, tokenAmount } = account.data.parsed.info;
        if (parseFloat(tokenAmount.uiAmount) > 0) {
          const decimals = tokenAmount.decimals;
          const amount = tokenAmount.uiAmount;
          response += `• ${amount.toFixed(4)} (Mint: \`${mint}\`)\n`;
        }
      }
    }

    bot.sendMessage(chatId, response, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Balance fetch error:", err.message);
    bot.sendMessage(chatId, "❌ Invalid wallet address or RPC error.");
  }
});

// /deletewallet command
bot.onText(/\/deletewallet/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const wallet = await WalletModel.findOne({ userId });
  if (!wallet) {
    return bot.sendMessage(chatId, "❌ You don't have a wallet to delete.");
  }

  const confirmationWord = `CONFIRM-DELETE-${Math.random()
    .toString(36)
    .substring(2, 10)
    .toUpperCase()}`;
  pendingDeletions[userId] = confirmationWord;

  bot.sendMessage(
    chatId,
    `
⚠️ Are you sure you want to delete your wallet?

To confirm, type exactly:
\`${confirmationWord}\`

This action is irreversible.
  `.trim(),
    { parse_mode: "Markdown" }
  );
});

// Listen for confirmation words
bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (text.startsWith("/")) return;

  if (pendingDeletions[userId]) {
    const expectedWord = pendingDeletions[userId];

    if (text === expectedWord) {
      await WalletModel.deleteOne({ userId });
      delete pendingDeletions[userId];
      bot.sendMessage(
        chatId,
        "✅ Your wallet has been permanently deleted. Click /start to create a new one."
      );
    } else {
      bot.sendMessage(
        chatId,
        "❌ Incorrect confirmation word. Wallet not deleted."
      );
    }
    return;
  }

  bot.sendMessage(chatId, "❓ I didn't understand that. Use /start to begin.");
});

bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  if (data.startsWith("sell_")) {
    const mintToSell = data.split("_")[1];

    bot.sendMessage(chatId, `🔁 Preparing to sell token: ${mintToSell}`);
    await handleSell(chatId, userId, mintToSell);
  }
});

// === GraphQL Query ===
bot.onText(/\/tokens/, async (msg) => {
  const chatId = msg.chat.id;
  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

  const myHeaders = new fetch.Headers();
  myHeaders.append("Content-Type", "application/json");
  myHeaders.append(
    "Authorization",
    "Bearer ory_at_Q3vfvKER1wCZzugycJQ2qj3Gc9dOXEGF8AP0I50635Q._-JjrPk6tPPAuGl9p6z9jpSwXLac19nOxfxwNEo0Zzs"
  );

  const raw = JSON.stringify({
    query: `{
  Solana {
    DEXTrades(
      limitBy: {by: Trade_Buy_Currency_MintAddress, count: 1}
      limit: {count: 5}
      orderBy: {descending: Block_Time}
      where: {
        Trade: {
          Dex: {ProtocolName: {is: "pump"}},
          Buy: {
            Currency: {MintAddress: {notIn: ["11111111111111111111111111111111"]}},
            PriceInUSD: {gt: 0.00001}
          },
          Sell: {AmountInUSD: {gt: "10"}}
        },
        Transaction: {Result: {Success: true}}
      }
    ) {
      Block {
        Time
      }
      Transaction {
        Signer
        Signature
      }
      Trade {
        Buy {
          Price(maximum: Block_Time)
          PriceInUSD(maximum: Block_Time)
          Currency {
            Name
            Symbol
            MintAddress
            Decimals
            Fungible
            Uri
          }
        }
        Market {
          MarketAddress
        }
      }
      joinTokenSupplyUpdates(
        TokenSupplyUpdate_Currency_MintAddress: Trade_Buy_Currency_MintAddress
        join: inner
        where: {
          Instruction: {
            Program: {
              Name: {is: "pump"},
              Method: {is: "create"}
            }
          },
          Block: {
            Time: {since: "${tenMinutesAgo}"}
          }
        }
      ) {
        Block {
          Time
        }
        Transaction {
          Dev: Signer
          Signature
        }
      }
    }
  }
}`,
    variables: "{}",
  });

  try {
    const response = await fetch("https://streaming.bitquery.io/eap", {
      method: "POST",
      headers: myHeaders,
      body: raw,
      redirect: "follow",
    });

    const data = await response.json();
    const trades = data?.data?.Solana?.DEXTrades || [];

    if (!trades.length) {
      return bot.sendMessage(chatId, "No recent tokens found.");
    }

    let message = `📊 *Recent Tokens (last 10 mins)*:\n\n`;

    trades.forEach((trade, index) => {
      const currency = trade.Trade.Buy.Currency;
      const price = trade.Trade.Buy.PriceInUSD;
      message += `🔹 *${currency.Name || "Unnamed"}* (${currency.Symbol})\n`;
      message += `💰 Price: $${price.toFixed(6)}\n`;
      message += `🧬 Mint: \`${currency.MintAddress}\`\n\n`;
    });

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("❌ Error:", error);
    bot.sendMessage(chatId, "Failed to fetch tokens.");
  }
});
