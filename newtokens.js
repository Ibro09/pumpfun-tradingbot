const fs = require("fs");
const fetch = require("node-fetch");
const now = new Date();
const tenMinutesAgo = new Date(now.getTime() - 1 * 60 * 1000).toISOString();
const myHeaders = new fetch.Headers();
console.log(tenMinutesAgo);

myHeaders.append("Content-Type", "application/json");
myHeaders.append(
  "Authorization",
  "Bearer ory_at_4DVLsJXN1ZlOmB2-xffzsX7wqmkTEARo2ZP9DP74t3g.fkxodeDyxUTSUVmpQK5G5CT7QIpjdwyWAHAqNJCWox0"
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
          },
          Sell: {AmountInUSD: {gt: "100"}}
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

const requestOptions = {
  method: "POST",
  headers: myHeaders,
  body: raw,
  redirect: "follow",
};

fetch("https://streaming.bitquery.io/eap", requestOptions)
  .then((response) => response.json())
  .then((result) => {
    fs.writeFileSync("response.json", JSON.stringify(result, null, 2));
    console.log("✅ Response saved to response.json");
  })
  .catch((error) => console.error("❌ Error:", error));
