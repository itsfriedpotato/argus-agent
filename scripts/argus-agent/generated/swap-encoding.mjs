// Generated from the Argus app source src/lib/contracts/swap-encoding.ts. Do not edit by hand.
import { encodeAbiParameters, encodeFunctionData } from "viem";
import { universalRouterAbi } from "./abis.mjs";
import { ARC_ADDRESSES } from "./addresses.mjs";
import { ACTIVE_CHAIN } from "./agent-chain.mjs";
const COMMAND_PERMIT2_PERMIT = "0x0a";
const COMMAND_V4_SWAP = "0x10";
const ACTIONS_EXACT_IN_SETTLE_TAKE = "0x060c0f";
export const PERMIT2_DOMAIN = {
    name: "Permit2",
    chainId: ACTIVE_CHAIN.id,
    verifyingContract: ARC_ADDRESSES.permit2,
};
export const PERMIT2_TYPES = {
    PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
    ],
    PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
    ],
};
function encodePermit2Permit({ permit, signature }) {
    return encodeAbiParameters([
        {
            name: "permitSingle",
            type: "tuple",
            components: [
                {
                    name: "details",
                    type: "tuple",
                    components: [
                        { name: "token", type: "address" },
                        { name: "amount", type: "uint160" },
                        { name: "expiration", type: "uint48" },
                        { name: "nonce", type: "uint48" },
                    ],
                },
                { name: "spender", type: "address" },
                { name: "sigDeadline", type: "uint256" },
            ],
        },
        { name: "signature", type: "bytes" },
    ], [permit, signature]);
}
export function encodeV4ExactInSwap(input) {
    const swap = encodeAbiParameters([
        {
            type: "tuple",
            components: [
                {
                    name: "poolKey",
                    type: "tuple",
                    components: [
                        { name: "currency0", type: "address" },
                        { name: "currency1", type: "address" },
                        { name: "fee", type: "uint24" },
                        { name: "tickSpacing", type: "int24" },
                        { name: "hooks", type: "address" },
                    ],
                },
                { name: "zeroForOne", type: "bool" },
                { name: "amountIn", type: "uint128" },
                { name: "amountOutMinimum", type: "uint128" },
                { name: "sqrtPriceLimitX96", type: "uint160" },
                { name: "hookData", type: "bytes" },
            ],
        },
    ], [
        {
            poolKey: input.key,
            zeroForOne: input.zeroForOne,
            amountIn: input.amountIn,
            amountOutMinimum: input.amountOutMinimum,
            sqrtPriceLimitX96: 0n,
            hookData: "0x",
        },
    ]);
    const currencyAmount = (currency, amount) => encodeAbiParameters([
        { name: "currency", type: "address" },
        { name: "amount", type: "uint256" },
    ], [currency, amount]);
    const actions = encodeAbiParameters([
        { name: "actions", type: "bytes" },
        { name: "params", type: "bytes[]" },
    ], [
        ACTIONS_EXACT_IN_SETTLE_TAKE,
        [
            swap,
            currencyAmount(input.currencyIn, input.amountIn),
            currencyAmount(input.currencyOut, input.amountOutMinimum),
        ],
    ]);
    const commands = input.permit ? `${COMMAND_PERMIT2_PERMIT}${COMMAND_V4_SWAP.slice(2)}` : COMMAND_V4_SWAP;
    const inputs = input.permit ? [encodePermit2Permit(input.permit), actions] : [actions];
    return encodeFunctionData({
        abi: universalRouterAbi,
        functionName: "execute",
        args: [commands, inputs, input.deadline],
    });
}
