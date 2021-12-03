import {ChainId} from "./chainid";

import {SwapPools} from "../swappools";
import {Token} from "../token";

import {BigNumberish} from "@ethersproject/bignumber";

const ETH_TOKEN_CHAINS = [ChainId.ETH, ChainId.BOBA, ChainId.ARBITRUM];

export namespace Networks {
    export class Network {
        readonly name:            string;
        readonly names:           string[];
        readonly chainCurrency:   string;
        readonly chainId:         number;
        readonly tokens:          Token[];
        readonly tokenAddresses:  string[];

        constructor(args: {
            name:        string,
            names?:      string[],
            chainId:     number,
            chainCurrency: string,
        }) {
            this.name = args.name
            this.names = args.names || [];
            this.chainId = args.chainId;
            this.chainCurrency = args.chainCurrency;

            this.tokens         = SwapPools.getAllSwappableTokensForNetwork(this.chainId);
            this.tokenAddresses = this.tokens.map((t) => t.address(this.chainId));
        }

        /**
         * Returns true if the Bridge Zap contract for this network
         * is a L2BridgeZap contract.
         * Currently, Ethereum mainnet is the only network for which the
         * Bridge Zap contract is a NerveBridgeZap contract.
         */
        get zapIsL2BridgeZap(): boolean {
            return this.chainId !== ChainId.ETH
        }

        /**
         * Returns true if the passed token is available on this network.
         * @param {Token|string} token Either an instance of Token, or the address of a token contract.
         */
        supportsToken(token: Token): boolean {
            if ((token.symbol === "ETH") && ETH_TOKEN_CHAINS.includes(this.chainId)) {
                return true
            }

            return this.tokenAddresses.includes(token.address(this.chainId));
        }
    }

    export const ETH = new Network({
        name:        "Ethereum Mainnet",
        names:      ["eth", "mainnet"],
        chainId:      ChainId.ETH,
        chainCurrency: "ETH"
    });

    export const BSC = new Network({
        name:        "Binance Smart Chain",
        names:      ["smart chain", "bsc"],
        chainId:      ChainId.BSC,
        chainCurrency: "BNB",
    });

    export const POLYGON = new Network({
        name:        "Polygon",
        names:      ["poly", "matic"],
        chainId:      ChainId.POLYGON,
        chainCurrency: "MATIC",
    });

    export const FANTOM = new Network({
        name:        "Fantom",
        names:      ["ftm"],
        chainId:      ChainId.FANTOM,
        chainCurrency: "FTM",
    });

    export const BOBA = new Network({
       name:         "Boba Network",
       chainId:       ChainId.BOBA,
       chainCurrency: "ETH",
    });

    export const MOONRIVER = new Network({
        name:          "Moonriver",
        chainId:       ChainId.MOONRIVER,
        chainCurrency: "MOVR",
    });

    export const ARBITRUM = new Network({
        name:        "Arbitrum",
        names:       ["arbi", "arb"],
        chainId:      ChainId.ARBITRUM,
        chainCurrency: "ETH",
    });

    export const AVALANCHE = new Network({
        name:        "Avalanche C-Chain",
        names:       ["avalanche", "avax"],
        chainId:      ChainId.AVALANCHE,
        chainCurrency: "AVAX",
    });

    export const HARMONY = new Network({
        name:        "Harmony",
        chainId:      ChainId.HARMONY,
        chainCurrency: "ONE",
    });

    const CHAINID_NETWORK_MAP: {[c:number]:Network} = {
        [ChainId.ETH]:        ETH,
        [ChainId.BSC]:        BSC,
        [ChainId.POLYGON]:    POLYGON,
        [ChainId.FANTOM]:     FANTOM,
        [ChainId.BOBA]:       BOBA,
        [ChainId.MOONRIVER]:  MOONRIVER,
        [ChainId.ARBITRUM]:   ARBITRUM,
        [ChainId.AVALANCHE]:  AVALANCHE,
        [ChainId.HARMONY]:    HARMONY,
    }

    export const fromChainId = (chainId: BigNumberish): Network => CHAINID_NETWORK_MAP[ChainId.asNumber(chainId)] ?? null

    /**
     * Returns true if the passed network supports the passed token.
     * @param {Network | BigNumberish} network Either a Network instance, or the Chain ID of a supported network.
     * @param {Token | string} token Either a Token instance, or the address of a token contract.
     */
    export function networkSupportsToken(network: Network | BigNumberish, token: Token): boolean {
        network = network instanceof Network ? network : fromChainId(network);
        return network.supportsToken(token);
    }

    export const supportedNetworks = (): Network[] => Object.values(CHAINID_NETWORK_MAP)
}

export const supportedNetworks = Networks.supportedNetworks;