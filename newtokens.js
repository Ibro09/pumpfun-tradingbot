const fs = require("fs");
const fetch = require("node-fetch");
 const tenMinutesAgo = new Date(
      now.getTime() - 10 * 60 * 1000
    ).toISOString();
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
  variables: "{}"
});

const requestOptions = {
  method: "POST",
  headers: myHeaders,
  body: raw,
  redirect: "follow"
};

fetch("https://streaming.bitquery.io/eap", requestOptions)
  .then(response => response.json())
  .then(result => {
    fs.writeFileSync("response.json", JSON.stringify(result, null, 2));
    console.log("✅ Response saved to response.json");
  })
  .catch(error => console.error("❌ Error:", error));
