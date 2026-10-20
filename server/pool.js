// Sunucunun RacePool kontratıyla konuşması: ödemeyi zincirden doğrulamak ve sıralamayı imzalamak.
// Sunucu zincire İŞLEM GÖNDERMEZ (gaz harcamaz, nonce tutmaz): sadece okur ve imzalar.
import { JsonRpcProvider, Wallet, Contract, AbiCoder, keccak256, getBytes, getAddress, verifyMessage } from 'ethers'
import { ownershipMessage } from '../shared/protocol.js'

const POOL_ABI = [
  'function getRoom(uint256 roomId) view returns (uint256 entryFee, uint8 maxPlayers, uint64 createdAt, uint64 startedAt, bool settled, address[] players)',
  'function resultSigner() view returns (address)',
]

// Kanıtı doğrula: imzadan adresi geri bul, iddia edilen adresle aynı mı?
export function verifyOwnership(socketId, address, proof) {
  try {
    return getAddress(verifyMessage(ownershipMessage(socketId), proof)) === getAddress(address)
  } catch {
    return false // bozuk imza / adres
  }
}

// rpcUrl, address (RacePool), signerKey (RESULT_SIGNER_KEY). Biri eksikse null: ücretli oda kapalı
export function createPool({ rpcUrl, address, signerKey }) {
  if (!address || !signerKey) return null
  if (!/^0x[0-9a-fA-F]{64}$/.test(signerKey)) {
    console.warn('⚠️  RESULT_SIGNER_KEY geçersiz (0x + 64 hane olmalı): ücretli oda kapalı')
    return null
  }
  const provider = new JsonRpcProvider(rpcUrl)
  const contract = new Contract(address, POOL_ABI, provider)
  const signer = new Wallet(signerKey)
  let chainId = null

  async function getChainId() {
    chainId ??= (await provider.getNetwork()).chainId
    return chainId
  }

  return {
    address: getAddress(address),
    signerAddress: signer.address,

    // Açılışta: kontrattaki resultSigner bizim anahtarımızın adresi mi? Değilse imzalar reddedilir
    async checkSigner() {
      return getAddress(await contract.resultSigner()) === signer.address
    },

    async getRoom(roomId) {
      const r = await contract.getRoom(roomId)
      return {
        entryFee: r.entryFee, // BigInt (wei)
        maxPlayers: Number(r.maxPlayers),
        createdAt: Number(r.createdAt),
        startedAt: Number(r.startedAt),
        settled: r.settled,
        players: r.players.map((p) => getAddress(p)),
      }
    },

    // Kontrattaki resultHash ile birebir aynı: keccak256(abi.encode(chainid, kontrat, roomId, ranking)).
    // signMessage önüne "\x19Ethereum Signed Message:\n32" ekler; kontrat toEthSignedMessageHash ile aynısını yapar
    async signRanking(roomId, ranking) {
      const encoded = AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'address', 'uint256', 'address[]'],
        [await getChainId(), address, roomId, ranking],
      )
      return signer.signMessage(getBytes(keccak256(encoded)))
    },
  }
}
