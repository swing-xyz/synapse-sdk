import {ChainId}  from "@chainid";
import {Networks} from "@networks";

import {
    contractAddressFor,
    executePopulatedTransaction,
    rejectPromise,
} from "@common/utils";

import type {ID}               from "@internal/entity";
import {SwapType}              from "@internal/swaptype";
import {rpcProviderForNetwork} from "@internal/rpcproviders";

import type {
    GenericZapBridgeContract,
    L1BridgeZapContract,
    SynapseBridgeContract,
} from "@contracts";

import {Tokens}          from "@tokens";
import {TokenSwap}       from "@tokenswap";
import {SwapPools}       from "@swappools";
import {SynapseEntities} from "@entities";

import type {Token}              from "@token";
import {BaseToken, WrappedToken} from "@token";

import type {ChainIdTypeMap} from "@common/types";

import {GasUtils}                   from "./gasutils";
import {BridgeUtils}                from "./bridgeutils";
import {ERC20, MAX_APPROVAL_AMOUNT} from "./erc20";

import {Zero}                    from "@ethersproject/constants";
import {formatUnits}             from "@ethersproject/units";
import {BigNumber, BigNumberish} from "@ethersproject/bignumber";

import type {Signer}   from "@ethersproject/abstract-signer";
import type {Provider} from "@ethersproject/providers";

import type {
    ContractTransaction,
    PopulatedTransaction,
} from "@ethersproject/contracts";

/**
 * Bridge provides a wrapper around common Synapse Bridge interactions, such as output estimation, checking supported swaps/bridges,
 * and most importantly, executing Bridge transactions.
 */
export namespace Bridge {
    type CanBridgeResult = [boolean, Error];
    export type CheckCanBridgeResult = [boolean, BigNumber];

    export interface BridgeOutputEstimate {
        amountToReceive: BigNumber,
        bridgeFee:       BigNumber,
    }

    /**
     * @param {Token} tokenFrom {@link Token} user will send to the bridge on the source chain
     * @param {Token} tokenTo {@link Token} user will receive from the bridge on the destination chain
     * @param {number} chainIdTo Chain ID of the destination chain
     * @param {BigNumber} amountFrom not necessarily used by this interface, and overriden in BridgeParamsWithAmounts.
     */
    export interface BridgeParams {
        tokenFrom:   Token,
        tokenTo:     Token
        chainIdTo:   number,
        amountFrom?: BigNumber,
    }

    /**
     * @param {BigNumber} amountFrom Amount of tokenFrom (denoted in wei) that the user will send to the bridge on the source chain.
     * @param {BigNumber} amountTo Amount of tokenTo (denoted in wei) that the user will receive from the bridge on the destination chain.
     * @param {string} addressTo Optional, user can provide an address other than the one retrieved from signer to receive tokens
     * on the destination chain.
     */
    export interface BridgeTransactionParams extends BridgeParams {
        amountFrom: BigNumber,
        amountTo:   BigNumber,
        addressTo?: string
    }

    interface EasyArgsCheck {
        isEasy:   boolean,
        castArgs: BridgeUtils.BridgeTxParams,
        txn?:     Promise<PopulatedTransaction>,
    }

    interface BridgeTokenArgs {
        fromChainTokens: Token[],
        toChainTokens:   Token[],
        tokenFrom:       Token,
        tokenTo:         Token,
        tokenIndexFrom:  number,
        tokenIndexTo:    number,
    }

    interface CheckCanBridgeParams {
        address: string,
        token:   Token,
        amount:  BigNumberish,
    }

    /**
     * SynapseBridge is a wrapper around any Synapse Bridge contract which exists on chains supported by the Synapse Protocol.
     */
    export class SynapseBridge {
        protected network: Networks.Network;
        protected chainId: number;
        protected provider: Provider;

        private readonly bridgeAddress: string;

        private readonly bridgeInstance:           SynapseBridgeContract;
        private readonly networkZapBridgeInstance: GenericZapBridgeContract;

        private readonly isL2Zap:      boolean;
        private readonly isL2ETHChain: boolean;

        private readonly zapBridgeAddress: string;

        private readonly bridgeConfigInstance = SynapseEntities.bridgeConfigV3();
        private readonly zapBridgeInstance = SynapseEntities.l1BridgeZap({
            chainId: ChainId.ETH,
            signerOrProvider: rpcProviderForNetwork(ChainId.ETH),
        });

        readonly requiredConfirmations: number;

        constructor(args: {
            network: Networks.Network | number,
            provider?: Provider
        }) {
            let {network, provider} = args;

            this.network = network instanceof Networks.Network ? network : Networks.fromChainId(network);
            this.chainId = this.network.chainId;
            this.provider = provider ?? rpcProviderForNetwork(this.chainId);

            this.requiredConfirmations = getRequiredConfirmationsForBridge(this.network);

            this.isL2Zap = this.network.zapIsL2BridgeZap;
            this.isL2ETHChain = BridgeUtils.isL2ETHChain(this.chainId);

            let factoryParams = {chainId: this.chainId, signerOrProvider: this.provider};

            this.bridgeInstance = SynapseEntities.synapseBridge(factoryParams);
            this.bridgeAddress = contractAddressFor(this.chainId, "bridge");

            this.networkZapBridgeInstance = SynapseEntities.zapBridge({ chainId: this.chainId, signerOrProvider: this.provider })

            this.zapBridgeAddress = this.networkZapBridgeInstance.address;
        }

        bridgeVersion(): Promise<BigNumber> {
            return this.bridgeInstance.bridgeVersion()
        }

        WETH_ADDRESS(): Promise<string> {
            return this.bridgeInstance.WETH_ADDRESS()
        }

        /**
         * Returns whether a swap/bridge from this Bridge's chain to another chain between two tokens
         * is supported.
         * @param {Token} args.tokenFrom {@link Token} user will send to the bridge
         * @param {Token} args.tokenTo {@link Token} user will receive from the bridge on the destination chain
         * @param {number} args.chainIdTo Chain ID of the destination chain
         * @return boolean value denoting whether the input params constitute a valid swap/bridge, along with a
         * string value denoting the reason for an unsupported swap, if applicable.
         */
        swapSupported(args: {
            tokenFrom: Token,
            tokenTo:   Token
            chainIdTo: number,
        }): [boolean, string] {
            const {swapSupported, reasonNotSupported} = TokenSwap.bridgeSwapSupported({...args, chainIdFrom: this.chainId});

            return [swapSupported, reasonNotSupported?.reason || ""]
        }

        /**
         * Returns the estimated output of a given token on the destination chain were a user to send
         * some amount of another given token on the source chain.
         * @param {BridgeParams} args Parameters for the output estimation.
         * @return {Promise<BridgeOutputEstimate>} Object containing the estimated output of args.tokenTo, as well
         * as the estimated fee to be taken by the bridge. Note that the estimated output already accounts for the
         * bridge fee, so the bridge fee is entirely for user-facing purposes. Do not use it for calculations.
         */
        async estimateBridgeTokenOutput(args: BridgeParams): Promise<BridgeOutputEstimate> {
            return this.checkSwapSupported(args)
                .then(() => this.calculateBridgeRate(args))
                .catch(rejectPromise)
        }

        /**
         * Returns a populated transaction for initiating a token bridge between this Bridge (the source chain) and the bridge contract on the destination chain.
         * Note that this function **does not** send a signed transaction.
         * @param {BridgeTransactionParams} args Parameters for the bridge transaction
         * @return {Promise<PopulatedTransaction>} Populated transaction instance which can be sent via ones choice
         * of web3/ethers/etc.
         */
        async buildBridgeTokenTransaction(args: BridgeTransactionParams): Promise<PopulatedTransaction> {
            const
                {addressTo} = args,
                tokenArgs = this.makeBridgeTokenArgs(args),
                {tokenFrom, tokenTo} = tokenArgs;

            if ((!addressTo) || addressTo === "") {
                return rejectPromise(
                    new Error("BridgeTransactionParams.addressTo cannot be empty string or undefined")
                )
            }

            args = {...args, tokenFrom, tokenTo};

            let newTxn: Promise<PopulatedTransaction> = this.chainId === ChainId.ETH
                ? this.buildETHMainnetBridgeTxn(args, tokenArgs)
                : this.buildL2BridgeTxn(args, tokenArgs);

            return newTxn
                .then((txn) => GasUtils.populateGasParams(this.chainId, txn, "bridge"))
                .catch(rejectPromise)
        }

        /**
         * Starts the Bridge process between this Bridge (the source chain) and the bridge contract on the destination chain.
         * Note that this function **does** send a signed transaction.
         * @param {BridgeTransactionParams} args Parameters for the bridge transaction.
         * @param {Signer} signer Some instance which implements the Ethersjs {@link Signer} interface.
         * @return {Promise<ContractTransaction>}
         */
        async executeBridgeTokenTransaction(args: BridgeTransactionParams, signer: Signer): Promise<ContractTransaction> {
            try {
                await this.checkSwapSupported(args);
            } catch (e) {
                return rejectPromise(e);
            }

            const
                {tokenFrom, amountFrom, addressTo} = args,
                signerAddress = await signer.getAddress();

            args.addressTo = addressTo ?? signerAddress

            return this.checkCanBridge({
                address: signerAddress,
                token: tokenFrom,
                amount: amountFrom,
            })
                .then((canBridgeRes: CanBridgeResult) => {
                    const [canBridge, err] = canBridgeRes;

                    if (!canBridge) {
                        return rejectPromise(err)
                    }

                    let txnProm = this.buildBridgeTokenTransaction(args);

                    return executePopulatedTransaction(txnProm, signer)
                })
                .catch(rejectPromise)
        }

        /**
         * Builds an ethers PopulatedTransaction instance for an ERC20 Approve call,
         * approving some amount of a given token to be spent by the Synapse Bridge on its chain.
         * The returned PopulatedTransaction must then be passed to the user via Web3 or some other
         * framework so they can ultimately send the transaction.
         * Should ALWAYS be called before performing any bridge transactions to ensure they don't fail.
         * @param {Object} args
         * @param {Token|string} args.token {@link Token} instance or valid on-chain address of the token the user will be sending
         * to the bridge on the source chain.
         * @param {BigNumberish} args.amount Optional, a specific amount of args.token to approve. By default, this function
         * builds an Approve call using an "infinite" approval amount.
         * @return {Promise<PopulatedTransaction>} Populated transaction instance which can be sent via ones choice
         * of web3/ethers/etc.
         */
        async buildApproveTransaction(args: {
            token:   Token | string,
            amount?: BigNumberish
        }): Promise<PopulatedTransaction> {
            const [approveArgs, tokenAddress] = this.buildERC20ApproveArgs(args);

            return ERC20.buildApproveTransaction(approveArgs, {tokenAddress, chainId: this.chainId})
        }

        /**
         * Builds and executes an ERC20 Approve call,
         * approving some amount of a given token to be spent by the Synapse Bridge on its chain.
         * The returned PopulatedTransaction must then be passed to the user via Web3 or some other
         * framework so they can ultimately send the transaction.
         * Should ALWAYS be called before performing any bridge transactions to ensure they don't fail.
         * @param {Object} args
         * @param {Token|string} args.token {@link Token} instance or valid on-chain address of the token the user will be sending
         * to the bridge on the source chain.
         * @param {BigNumberish} args.amount Optional, a specific amount of args.token to approve. By default, this function
         * @param {Signer} signer Valid ethers Signer instance for building a fully and properly populated
         * transaction.
         */
        async executeApproveTransaction(args: {
            token:   Token | string,
            amount?: BigNumberish
        }, signer: Signer): Promise<ContractTransaction> {
            const [approveArgs, tokenAddress] = this.buildERC20ApproveArgs(args);

            return Promise.resolve(
                ERC20.approve(approveArgs, {tokenAddress, chainId: this.chainId}, signer)
                    .then((res: ContractTransaction) => res)
            )
        }

        async getAllowanceForAddress(args: {
            address: string,
            token:   Token,
        }): Promise<BigNumber> {
            let { address, token } = args;
            let tokenAddress = token.address(this.chainId);

            return ERC20.allowanceOf(address, this.zapBridgeAddress, {tokenAddress, chainId: this.chainId})
        }



        private async checkNeedsApprove({
            address,
            token,
            amount=MAX_APPROVAL_AMOUNT.sub(1)
        }: CheckCanBridgeParams): Promise<CheckCanBridgeResult> {
            const [{spender}, tokenAddress] = this.buildERC20ApproveArgs({token, amount});

            return ERC20.allowanceOf(address, spender, {tokenAddress, chainId: this.chainId})
                .then((allowance: BigNumber) => {
                    const res: CheckCanBridgeResult = [allowance.lt(amount), allowance];
                    return res
                })
                .catch(rejectPromise)
        }

        private async checkHasBalance({address, amount, token}: CheckCanBridgeParams): Promise<CheckCanBridgeResult> {
            const
                [, tokenAddress] = this.buildERC20ApproveArgs({token, amount});

            return ERC20.balanceOf(address, {tokenAddress, chainId: this.chainId})
                .then((balance: BigNumber) => {
                    const res: CheckCanBridgeResult = [balance.gte(amount), balance];
                    return res
                })
                .catch(rejectPromise)
        }

        private async checkCanBridge(args: CheckCanBridgeParams): Promise<CanBridgeResult> {
            const {token} = args;

            const hasBalanceRes = this.checkHasBalance(args)
                .then((balanceRes) => {
                    const [hasBalance, balance] = balanceRes;
                    if (!hasBalance) {
                        let balanceEth: string = formatUnits(balance, token.decimals(this.chainId)).toString();
                        let ret: CanBridgeResult = [false, new Error(`Balance of token ${token.symbol} is too low; current balance is ${balanceEth}`)];
                        return ret
                    }

                    let ret: CanBridgeResult = [true, null];
                    return ret
                })
                .catch(rejectPromise)

            return this.checkNeedsApprove(args)
                .then((approveRes) => {
                    const [needsApprove, allowance] = approveRes;
                    if (needsApprove) {
                        let allowanceEth: string = formatUnits(allowance, token.decimals(this.chainId)).toString();
                        let ret: CanBridgeResult = [false, new Error(`Spend allowance of Bridge too low for token ${token.symbol}; current allowance for Bridge is ${allowanceEth}`)];
                        return ret
                    }

                    return hasBalanceRes
                })
                .catch(rejectPromise)
        }

        private buildERC20ApproveArgs(args: {
            token:   Token | string,
            amount?: BigNumberish
        }): [ERC20.ApproveArgs, string] {
            const {token, amount} = args;

            let tokenAddr: string = (token instanceof BaseToken) || (token instanceof WrappedToken)
                ? token.address(this.chainId)
                : token as string;

            return [{
                spender: this.zapBridgeAddress,
                amount
            }, tokenAddr]
        }

        private async checkSwapSupported(args: BridgeParams): Promise<boolean> {
            return new Promise<boolean>((resolve, reject) => {
                let [swapSupported, errReason] = this.swapSupported(args);
                if (!swapSupported) {
                    reject(errReason);
                    return
                }

                resolve(true);
            })
        }

        private async calculateBridgeRate(args: BridgeParams): Promise<BridgeOutputEstimate> {
            let {chainIdTo, amountFrom} = args;

            const toChainZapParams = {chainId: chainIdTo, signerOrProvider: rpcProviderForNetwork(chainIdTo)};
            const toChainZap: GenericZapBridgeContract = SynapseEntities.zapBridge(toChainZapParams);

            const {
                tokenFrom, tokenTo,
                tokenIndexFrom, tokenIndexTo,
                fromChainTokens
            } = this.makeBridgeTokenArgs(args);


            let {intermediateToken, bridgeConfigIntermediateToken} = TokenSwap.intermediateTokens(chainIdTo, tokenFrom);

            const bigNumTen = BigNumber.from(10);
            const bridgeFeeRequest = this.bridgeConfigInstance.functions["calculateSwapFee(address,uint256,uint256)"](
                bridgeConfigIntermediateToken.address(chainIdTo),
                chainIdTo,
                amountFrom.mul(bigNumTen.pow(18-tokenFrom.decimals(this.chainId)))
            ).then((res: [BigNumber]) => res[0] ?? null).catch(rejectPromise);

            const checkEthy = (c: number, t: Token): boolean => BridgeUtils.isL2ETHChain(c) && t.swapType === SwapType.ETH

            const
                ethToEth:   boolean = this.chainId === ChainId.ETH && checkEthy(chainIdTo,    tokenTo),
                ethFromEth: boolean = chainIdTo    === ChainId.ETH && checkEthy(this.chainId, tokenFrom);

            let amountToReceive_from: BigNumber;
            switch (true) {
                case amountFrom.eq(Zero):
                    amountToReceive_from = Zero;
                    break;
                case ethToEth:
                case Tokens.isMintBurnToken(tokenFrom):
                case tokenFrom.isWrappedToken:
                    amountToReceive_from = amountFrom;
                    break;
                case this.chainId === ChainId.ETH:
                    let liquidityAmounts = fromChainTokens.map((t) => tokenFrom.isEqual(t) ? amountFrom : Zero);
                    amountToReceive_from = await this.zapBridgeInstance.calculateTokenAmount(liquidityAmounts, true);

                    break;
                default:
                    amountToReceive_from = await BridgeUtils.calculateSwapL2Zap(
                        this.networkZapBridgeInstance,
                        intermediateToken.address(this.chainId),
                        tokenIndexFrom,
                        0,
                        amountFrom
                    );
            }

            let bridgeFee: BigNumber;
            try {
                bridgeFee = await bridgeFeeRequest;
            } catch (e) {
                console.error(`Error in bridge fee request: ${e}`);
                return null
            }

            amountToReceive_from = BridgeUtils.subBigNumSafe(amountToReceive_from, bridgeFee);

            let amountToReceive_to: BigNumber;
            switch (true) {
                case amountToReceive_from.isZero():
                    amountToReceive_to = Zero;
                    break;
                case ethFromEth:
                case Tokens.isMintBurnToken(tokenTo):
                case tokenTo.isWrappedToken:
                    amountToReceive_to = amountToReceive_from;
                    break;
                case chainIdTo === ChainId.ETH:
                    amountToReceive_to = await (toChainZap as L1BridgeZapContract)
                        .calculateRemoveLiquidityOneToken(amountToReceive_from, tokenIndexTo);

                    break;
                default:
                    amountToReceive_to = await BridgeUtils.calculateSwapL2Zap(
                        toChainZap,
                        intermediateToken.address(chainIdTo),
                        0,
                        tokenIndexTo,
                        amountToReceive_from
                    );
            }

            let amountToReceive = amountToReceive_to;

            return {amountToReceive, bridgeFee}
        }

        private checkEasyArgs(
            args: BridgeTransactionParams,
            zapBridge: GenericZapBridgeContract,
            easyDeposits:    ID[],
            easyRedeems:     ID[],
            easyDepositETH?: ID[],
        ): EasyArgsCheck {
            let
                castArgs = args as BridgeUtils.BridgeTxParams,
                isEasy: boolean = false,
                txn:    Promise<PopulatedTransaction>;

            const params = BridgeUtils.makeEasyParams(castArgs, this.chainId, args.tokenTo);

            switch (true) {
                case easyRedeems.includes(args.tokenTo.id):
                    isEasy = true;
                    txn    = zapBridge.populateTransaction.redeem(...params);
                    break;
                case easyDeposits.includes(args.tokenTo.id):
                    isEasy = true;
                    txn    = zapBridge.populateTransaction.deposit(...params);
                    break;
                case easyDepositETH.includes(args.tokenTo.id):
                    isEasy = true;
                    txn    =  zapBridge
                        .populateTransaction
                        .depositETH(
                            ...BridgeUtils.depositETHParams(castArgs),
                            {value: args.amountFrom}
                        );
                    break;
            }

            return {castArgs, isEasy, txn}
        }

        private buildETHMainnetBridgeTxn(
            args:      BridgeTransactionParams,
            tokenArgs: BridgeTokenArgs
        ): Promise<PopulatedTransaction> {
            const
                {addressTo, chainIdTo, amountFrom, amountTo} = args,
                zapBridge = SynapseEntities.l1BridgeZap({
                    chainId: this.chainId,
                    signerOrProvider: this.provider
                });

            let
                easyRedeems:    ID[] = [Tokens.SYN.id],
                easyDeposits:   ID[] = [Tokens.HIGH.id, Tokens.DOG.id, Tokens.FRAX.id],
                easyDepositETH: ID[] = [Tokens.NETH.id];

            if (args.tokenFrom.isEqual(Tokens.NUSD)) easyDeposits.push(Tokens.NUSD.id);

            let {castArgs, isEasy, txn} = this.checkEasyArgs(args, zapBridge, easyDeposits, easyRedeems, easyDepositETH);
            if (isEasy && txn) {
                return txn
            }

            const {
                transactionDeadline,
                bridgeTransactionDeadline,
                minToSwapDestFromOrigin,
                minToSwapDest,
                minToSwapOriginMediumSlippage,
                minToSwapDestFromOriginMediumSlippage,
            } = BridgeUtils.getSlippages(amountFrom, amountTo);

            switch (args.tokenTo.id) {
                case Tokens.NUSD.id:
                    if (!args.tokenFrom.isEqual(Tokens.NUSD)) {
                        const liquidityAmounts = tokenArgs
                            .fromChainTokens
                            .map((t) => args.tokenFrom.isEqual(t) ? amountFrom : Zero);

                        return zapBridge.populateTransaction.zapAndDeposit(
                            addressTo,
                            chainIdTo,
                            Tokens.NUSD.address(this.chainId),
                            liquidityAmounts,
                            minToSwapDest,
                            transactionDeadline,
                        )
                    }
                    break;
                default:
                    if (BridgeUtils.isETHLikeToken(args.tokenTo) || args.tokenTo.isEqual(Tokens.WETH)) {
                        return zapBridge.populateTransaction.depositETHAndSwap(
                            ...BridgeUtils.depositETHParams(castArgs),
                            0, // nusd tokenindex,
                            tokenArgs.tokenIndexTo,
                            minToSwapDestFromOrigin, // minDy
                            bridgeTransactionDeadline,
                            {value: amountFrom}
                        )
                    }

                    const liquidityAmounts = tokenArgs
                        .fromChainTokens
                        .map((t) => args.tokenFrom.isEqual(t) ? amountFrom : Zero);

                    return zapBridge.populateTransaction.zapAndDepositAndSwap(
                        addressTo,
                        chainIdTo,
                        Tokens.NUSD.address(this.chainId),
                        liquidityAmounts,
                        minToSwapOriginMediumSlippage, // minToSwapOrigin,
                        transactionDeadline,
                        0,
                        tokenArgs.tokenIndexTo,
                        minToSwapDestFromOriginMediumSlippage, //, minToSwapDestFromOrigin, // minDy
                        bridgeTransactionDeadline,
                    )
            }
        }

        private buildL2BridgeTxn(
            args: BridgeTransactionParams,
            tokenArgs: BridgeTokenArgs
        ): Promise<PopulatedTransaction> {
            const
                {chainIdTo, amountFrom, amountTo} = args,
                zapBridge = SynapseEntities.l2BridgeZap({
                    chainId: this.chainId,
                    signerOrProvider: this.provider
                });

            tokenArgs.tokenFrom = tokenArgs.tokenFrom.isEqual(Tokens.AVWETH)
                ? Tokens.WETH_E
                : tokenArgs.tokenFrom;

            let
                easyDeposits:   ID[] = [],
                easyRedeems:    ID[] = [Tokens.SYN.id, Tokens.HIGH.id, Tokens.DOG.id, Tokens.FRAX.id],
                easyDepositETH: ID[] = [];

            if (args.tokenFrom.isEqual(Tokens.NUSD)) easyRedeems.push(Tokens.NUSD.id);

            BridgeUtils.DepositIfChainTokens.forEach((args) => {
                let {chainId, tokens, depositEth, altChainId} = args;

                let
                    hasAltChain = typeof altChainId !== 'undefined',
                    tokenHashes = tokens.map((t) => t.id);

                if (this.chainId === chainId) {
                    depositEth
                        ? easyDepositETH.push(...tokenHashes)
                        : easyDeposits.push(...tokenHashes);
                } else {
                    if (hasAltChain) {
                        if (this.chainId === altChainId) easyRedeems.push(...tokenHashes);
                    } else {
                        easyRedeems.push(...tokenHashes);
                    }
                }
            })

            let {castArgs, isEasy, txn} = this.checkEasyArgs(args, zapBridge, easyDeposits, easyRedeems, easyDepositETH);

            if (isEasy && txn) {
                return txn
            }

            const {
                transactionDeadline,
                bridgeTransactionDeadline,
                minToSwapOriginHighSlippage,
                minToSwapDestFromOriginHighSlippage,
                minToSwapDest,
            } = BridgeUtils.getSlippages(amountFrom, amountTo);

            const easyRedeemAndSwap = (baseToken: BaseToken): Promise<PopulatedTransaction> =>
                zapBridge
                    .populateTransaction
                    .redeemAndSwap(
                        ...BridgeUtils.makeEasyParams(castArgs, this.chainId, baseToken),
                        0,
                        tokenArgs.tokenIndexTo,
                        minToSwapDest,
                        transactionDeadline,
                    )

            const easySwapAndRedeemAndSwap = (baseToken: BaseToken, withValueOverride: boolean): Promise<PopulatedTransaction> =>
                zapBridge
                    .populateTransaction
                    .swapAndRedeemAndSwap(
                        ...BridgeUtils.makeEasySubParams(castArgs, this.chainId, baseToken),
                        tokenArgs.tokenIndexFrom,
                        0,
                        amountFrom,
                        minToSwapOriginHighSlippage,
                        transactionDeadline,
                        0,
                        tokenArgs.tokenIndexTo,
                        minToSwapDestFromOriginHighSlippage, // swapMinAmount
                        bridgeTransactionDeadline, // toSwapDeadline, // swapDeadline
                        BridgeUtils.makeOverrides(amountFrom, withValueOverride),
                    )

            switch (args.tokenTo.id) {
                case Tokens.NUSD.id:
                    return zapBridge
                        .populateTransaction
                        .swapAndRedeem(
                            ...BridgeUtils.makeEasySubParams(castArgs, this.chainId, Tokens.NUSD),
                            tokenArgs.tokenIndexFrom,
                            0,
                            amountFrom,
                            minToSwapOriginHighSlippage,
                            transactionDeadline
                        )
                case Tokens.GMX.id:
                    let params = BridgeUtils.makeEasyParams(castArgs, this.chainId, Tokens.GMX);
                    switch (this.chainId) {
                        case ChainId.ARBITRUM:
                            return zapBridge.populateTransaction.deposit(...params)
                        default:
                            let [addrTo, chainTo,,amount] = params;
                            return this.bridgeInstance
                                .populateTransaction
                                .redeem(
                                    addrTo,
                                    chainTo,
                                    Tokens.GMX.wrapperAddress(this.chainId),
                                    amount
                                )
                    }
                default:
                    if (chainIdTo === ChainId.ETH) {
                        switch (true) {
                            case this.isL2ETHChain:
                                switch (true) {
                                    case args.tokenFrom.isEqual(Tokens.NETH):
                                        return zapBridge
                                            .populateTransaction
                                            .redeem(...BridgeUtils.makeEasyParams(castArgs, this.chainId, Tokens.NETH))
                                    case BridgeUtils.isETHLikeToken(args.tokenFrom):
                                        return zapBridge
                                            .populateTransaction
                                            .swapAndRedeem(
                                                ...BridgeUtils.makeEasySubParams(castArgs, this.chainId, Tokens.NETH),
                                                tokenArgs.tokenIndexFrom,
                                                0,
                                                amountFrom,
                                                minToSwapOriginHighSlippage, // minToSwapOrigin, // minToSwapOriginHighSlippage,
                                                transactionDeadline
                                            )
                                    default:
                                        return zapBridge
                                            .populateTransaction
                                            .swapETHAndRedeem(
                                                ...BridgeUtils.makeEasySubParams(castArgs, this.chainId, Tokens.NETH),
                                                tokenArgs.tokenIndexFrom,
                                                0,
                                                amountFrom,
                                                minToSwapOriginHighSlippage, // minToSwapOrigin, // minToSwapOriginHighSlippage,
                                                transactionDeadline,
                                                {value: amountFrom}
                                            )
                                }
                            case args.tokenFrom.isEqual(Tokens.NUSD):
                                return zapBridge
                                    .populateTransaction
                                    .redeemAndRemove(
                                        ...BridgeUtils.makeEasySubParams(castArgs, this.chainId, Tokens.NUSD),
                                        amountFrom,
                                        tokenArgs.tokenIndexTo,
                                        minToSwapDest,
                                        transactionDeadline
                                    )
                            default:
                                return zapBridge
                                    .populateTransaction
                                    .swapAndRedeemAndRemove(
                                        ...BridgeUtils.makeEasySubParams(castArgs, this.chainId, Tokens.NUSD),
                                        tokenArgs.tokenIndexFrom,
                                        0,
                                        amountFrom,
                                        minToSwapOriginHighSlippage,
                                        transactionDeadline,
                                        tokenArgs.tokenIndexTo, //swapTokenIndex
                                        minToSwapDestFromOriginHighSlippage, // swapMinAmount
                                        bridgeTransactionDeadline, // toSwapDeadline, // swapDeadline
                                    )
                        }
                    } else {
                        switch (true) {
                            case args.tokenFrom.isEqual(Tokens.NUSD):
                                return easyRedeemAndSwap(Tokens.NUSD)
                            case args.tokenFrom.isEqual(Tokens.NETH):
                                return easyRedeemAndSwap(Tokens.NETH)
                            case args.tokenFrom.swapType === SwapType.ETH:
                                return BridgeUtils.isETHLikeToken(args.tokenFrom)
                                    ? easySwapAndRedeemAndSwap(Tokens.NETH, false)
                                    : zapBridge
                                        .populateTransaction
                                        .swapETHAndRedeemAndSwap(
                                            ...BridgeUtils.makeEasySubParams(castArgs, this.chainId, Tokens.NETH),
                                            tokenArgs.tokenIndexFrom,
                                            0,
                                            amountFrom,
                                            minToSwapOriginHighSlippage,
                                            transactionDeadline,
                                            0,
                                            tokenArgs.tokenIndexTo,
                                            minToSwapDestFromOriginHighSlippage,
                                            bridgeTransactionDeadline,
                                            {value: amountFrom}
                                        )
                            default:
                                return easySwapAndRedeemAndSwap(Tokens.NUSD, false)
                        }
                    }
            }
        }

        private makeBridgeTokenArgs(args: BridgeParams): BridgeTokenArgs {
            let {tokenFrom, tokenTo, chainIdTo} = args;

            const
                checkAndChangeToken = (
                    t:      Token,
                    check:  Token,
                    swappy: Token
                ): Token => t.isEqual(check) ? swappy : t,
                checkAndChangeTokens = (
                    check: Token,
                    swappy: Token
                ): ((t1: Token, t2: Token) => [Token, Token]) =>
                    (t1: Token, t2: Token) => [
                        checkAndChangeToken(t1, check, swappy),
                        checkAndChangeToken(t2, check, swappy)
                    ];

            let bridgeTokens: (t1: Token, t2: Token) => [Token, Token];

            switch (tokenFrom.swapType) {
                case SwapType.ETH:
                    bridgeTokens = checkAndChangeTokens(Tokens.ETH, Tokens.WETH);
                    break;
                case SwapType.AVAX:
                    bridgeTokens = checkAndChangeTokens(Tokens.AVAX, Tokens.WAVAX);
                    break;
                case SwapType.MOVR:
                    bridgeTokens = checkAndChangeTokens(Tokens.MOVR, Tokens.WMOVR);
                    break;
                default:
                    bridgeTokens = (t1: Token, t2: Token) => [t1, t2];
            }

            [tokenFrom, tokenTo] = bridgeTokens(tokenFrom, tokenTo);

            const findSymbol = (tokA: Token, tokB: Token): boolean => {
                let compareTok: Token = tokB;
                switch (true) {
                    case tokB.isEqual(Tokens.WETH_E):
                        compareTok = Tokens.AVWETH;
                        break;
                    case tokB.isEqual(Tokens.WETH):
                        compareTok = Tokens.WETH;
                        break;
                    case tokB.isWrappedToken:
                        compareTok = tokB.underlyingToken;
                        break;
                }

                return tokA.isEqual(compareTok);
            }

            const makeTokenArgs = (chainId: number, t: Token): [Token[], number] => {
                let
                    toks = SwapPools.bridgeSwappableTypePoolsByChain[chainId]?.[t.swapType]?.poolTokens,
                    idx  = toks.findIndex((tok: Token) => findSymbol(tok, t));

                return [toks, idx]
            }

            const
                [fromChainTokens, tokenIndexFrom] = makeTokenArgs(this.chainId, tokenFrom),
                [toChainTokens,   tokenIndexTo]   = makeTokenArgs(chainIdTo,    tokenTo);

            return {
                fromChainTokens,
                toChainTokens,
                tokenFrom,
                tokenTo,
                tokenIndexFrom,
                tokenIndexTo
            }
        }
    }

    const REQUIRED_CONFS: ChainIdTypeMap<number> = {
        [ChainId.ETH]:       7,
        [ChainId.OPTIMISM]:  1,
        [ChainId.BSC]:       14,
        [ChainId.POLYGON]:   128,
        [ChainId.FANTOM]:    5,
        [ChainId.BOBA]:      1,
        [ChainId.MOONBEAM]:  21,
        [ChainId.MOONRIVER]: 21,
        [ChainId.ARBITRUM]:  40,
        [ChainId.AVALANCHE]: 5,
        [ChainId.HARMONY]:   1,
    };

    export function getRequiredConfirmationsForBridge(network: Networks.Network | number): number {
        let chainId: number = network instanceof Networks.Network ? network.chainId : network;

        return REQUIRED_CONFS[chainId] ?? -1
    }

    interface EasyArgsCheck {
        isEasy: boolean,
        castArgs: BridgeUtils.BridgeTxParams,
        txn?: Promise<PopulatedTransaction>,
    }

    export function bridgeSwapSupported(args: TokenSwap.BridgeSwapSupportedParams): TokenSwap.SwapSupportedResult {
        return TokenSwap.bridgeSwapSupported(args)
    }
}