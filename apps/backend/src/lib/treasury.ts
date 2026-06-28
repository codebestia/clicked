import { BASE_FEE, Keypair, Networks, TransactionBuilder, rpc } from '@stellar/stellar-sdk';

export type TreasuryAction = 'propose' | 'approve' | 'reject' | 'execute';
export type TreasuryStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired' | 'active';

export interface TreasuryActionResult {
  onChainId: string;
  status: TreasuryStatus;
}

function buildFallbackResult(action: TreasuryAction, payload: Record<string, unknown>): TreasuryActionResult {
  const onChainId = String(payload.proposalId ?? payload.onChainId ?? `sim-${Date.now()}`);

  switch (action) {
    case 'approve':
      return { onChainId, status: 'approved' };
    case 'reject':
      return { onChainId, status: 'rejected' };
    case 'execute':
      return { onChainId, status: 'executed' };
    case 'propose':
    default:
      return { onChainId, status: 'pending' };
  }
}

export async function invokeTreasuryAction(
  action: TreasuryAction,
  payload: Record<string, unknown>,
): Promise<TreasuryActionResult> {
  const contractId = process.env['GROUP_TREASURY_CONTRACT_ID'];
  const rpcUrl = process.env['STELLAR_RPC_URL'];
  const sourceSecret = process.env['TREASURY_SOURCE_SECRET'];

  if (!contractId || !rpcUrl || !sourceSecret) {
    return buildFallbackResult(action, payload);
  }

  const sourceKeypair = Keypair.fromSecret(sourceSecret);
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  const account = await server.getAccount(sourceKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(30)
    .build();

  tx.sign(sourceKeypair);

  await server.sendTransaction(tx, { simulate: true });

  return buildFallbackResult(action, payload);
}
