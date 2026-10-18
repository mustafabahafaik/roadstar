// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RaceItems} from "./RaceItems.sol";

/// @title Race — yarış hakemi: yarışı başlatır, token toplama ve skill kurallarını uygular
/// @notice Oyun tarayıcıda çalıştığı için zincir sürüşü göremez. Hileyi fiziksel sınırlara sıkıştırırız:
///         tohumu zincir verir (iyi oda aranamaz), tokenlar ancak arabanın oraya varabileceği
///         zamandan sonra toplanabilir, yarış bitince / süresi dolunca toplama kapanır.
contract Race {
    uint8 internal constant GOLD = 4; // RaceItems.GOLD ile aynı

    // --- Oyundaki değerlerin cömert sınırları (dürüst oyuncu asla takılmasın) ---
    uint256 public constant ITEMS_PER_RACE = 40; // oyundaki TOKEN_COUNT
    uint256 public constant TRACK_LENGTH = 1900; // pist uzunluğunun alt sınırı (oyunda 1957)
    uint256 public constant MAX_SPEED = 115; // birim/sn üst sınırı (oyunda 70 × Block Rush 1.6 = 112)
    uint256 public constant PICKUP_REACH = 40; // mıknatıs (35) + toplama yarıçapı (4.5)
    uint256 public constant TIME_TOLERANCE = 3; // sn: blok zamanı saniye hassasiyetinde
    uint256 public constant MAX_DURATION = 15 minutes; // bu süreden sonra yarış kapanır

    struct RaceInfo {
        // 1. depolama yuvası (20 + 8 + 2 + 2 = 32 bayt)
        address player; // yarışı başlatan (tek oyuncu)
        uint64 startTime; // başladığı blok zamanı (sn)
        uint16 collectedCount; // toplanan token sayısı
        uint16 goldCount; // toplanan altın sayısı
        // 2. yuva
        uint64 finishTime; // bitiş zamanı (0 = bitmedi)
        uint64 collectedMask; // bitmap: bit i = 1 ise i. token toplandı (40 bit yeter)
        // 3. yuva
        bytes32 seed; // token türlerinin tohumu (zincir belirler)
    }

    /// @notice Yarışların token kontratı (Race onu kendisi oluşturur ve tek minter'ıdır)
    RaceItems public immutable items;

    /// @notice Şimdiye kadar başlatılan yarış sayısı (yeni yarış id'si = raceCount + 1)
    uint256 public raceCount;

    mapping(uint256 raceId => RaceInfo) public races;

    // --- Olaylar ---
    event RaceStarted(uint256 indexed raceId, address indexed player, bytes32 seed);
    event ItemCollected(uint256 indexed raceId, address indexed player, uint256 index, uint8 itemType);
    event SkillUsed(uint256 indexed raceId, address indexed player, uint8 itemType);
    event RaceFinished(uint256 indexed raceId, address indexed player, uint256 duration, uint256 collected, uint256 gold);

    // --- Hatalar ---
    error NotRacePlayer(uint256 raceId, address caller);
    error RaceNotActive(uint256 raceId);
    error IndexOutOfRange(uint256 index);
    error AlreadyCollected(uint256 raceId, uint256 index);
    error TooEarly(uint256 index, uint256 readyAt);
    error GoldNotUsable();
    error NoItem(uint256 raceId, uint8 itemType);
    error FinishTooEarly(uint256 duration, uint256 minimum);

    constructor() {
        items = new RaceItems(address(this)); // token kontratını oluştur, minter = bu kontrat
    }

    // =========================================================================
    // Hesaplamalar (pure: zincirden veri okumaz, dışarıdan çağırmak bedava)
    // =========================================================================

    /// @notice Tohum + index → token türü. Oyundaki src/random.js → itemTypeFromHash ile AYNI eşikler
    /// @dev hash % 10000 → 0..9999. 0-499 Altın (%5); kalan 9500'ün %40 Thrust, %20'şer diğerleri
    function itemAt(bytes32 seed, uint256 index) public pure returns (uint8) {
        uint256 roll = uint256(keccak256(abi.encode(seed, index))) % 10000;
        if (roll < 500) return GOLD;
        roll -= 500; // 0..9499
        if (roll < 3800) return 0; // Thrust Cell (9500 × 0.40)
        if (roll < 5700) return 1; // Kalkan     (+ 9500 × 0.20)
        if (roll < 7600) return 2; // Mıknatıs   (+ 9500 × 0.20)
        return 3; // Block Rush
    }

    /// @notice Token index'i yarış başladıktan en erken kaç saniye sonra toplanabilir?
    /// @dev Token i pistin en erken i/40'ında durur. Oraya en yüksek hızla varış süresi,
    ///      mıknatıs + toplama menzili kadar erken. Bundan önce gelen collect fiziksel olarak imkânsız
    function earliestCollectTime(uint256 index) public pure returns (uint256) {
        uint256 distance = (index * TRACK_LENGTH) / ITEMS_PER_RACE;
        if (distance <= PICKUP_REACH) return 0;
        return (distance - PICKUP_REACH) / MAX_SPEED;
    }

    // =========================================================================
    // Yarış başlatma
    // =========================================================================

    /// @notice Yeni yarış başlat. Numarayı ve tohumu zincir verir
    /// @dev Tohum blockhash içerir: oyuncu işlemi gönderirken bilemez → "altını bol oda" aranamaz
    function startRace() external returns (uint256 raceId) {
        raceId = ++raceCount; // önce artır, sonra kullan: ilk yarış 1
        bytes32 seed = keccak256(abi.encode(raceId, msg.sender, blockhash(block.number - 1)));
        races[raceId] = RaceInfo({
            player: msg.sender,
            startTime: uint64(block.timestamp),
            collectedCount: 0,
            goldCount: 0,
            finishTime: 0,
            collectedMask: 0,
            seed: seed
        });
        emit RaceStarted(raceId, msg.sender, seed);
    }

    // =========================================================================
    // Yarış içi işlemler (sıra: kontroller → durum değişikliği → mint/burn ve event)
    // =========================================================================

    /// @dev Ortak kontrol: çağıran yarışın sahibi mi, yarış hâlâ açık mı?
    ///      storage: kaydın kopyası değil kendisi → üzerinde yapılan değişiklik zincire yazılır
    function _activeRace(uint256 raceId) internal view returns (RaceInfo storage r) {
        r = races[raceId];
        if (r.player != msg.sender) revert NotRacePlayer(raceId, msg.sender);
        if (r.finishTime != 0 || block.timestamp > r.startTime + MAX_DURATION) revert RaceNotActive(raceId);
    }

    /// @notice Yolda bir tokenı topla: türü tohumdan hesaplanır, oyuncuya mint edilir
    function collect(uint256 raceId, uint256 index) external {
        // 1) Kontroller
        RaceInfo storage r = _activeRace(raceId);
        if (index >= ITEMS_PER_RACE) revert IndexOutOfRange(index);
        uint64 bit = uint64(1) << uint64(index); // sadece index. biti 1 olan sayı (index < 40, güvenli)
        if (r.collectedMask & bit != 0) revert AlreadyCollected(raceId, index);
        uint256 readyAt = r.startTime + earliestCollectTime(index);
        if (block.timestamp + TIME_TOLERANCE < readyAt) revert TooEarly(index, readyAt); // oraya henüz varamazdın

        // 2) Durum: önce işaretle (mint sırasında geri çağrılsa bile ikinci kez alınamaz)
        r.collectedMask |= bit;
        r.collectedCount++;
        uint8 itemType = itemAt(r.seed, index); // türü oyuncu seçemez
        if (itemType == GOLD) r.goldCount++;

        // 3) Mint + event
        items.mint(msg.sender, raceId, itemType);
        emit ItemCollected(raceId, msg.sender, index, itemType);
    }

    /// @notice Envanterdeki bir skill'i kullan: bu yarıştaki tokenından 1 tane yakılır
    function useSkill(uint256 raceId, uint8 itemType) external {
        _activeRace(raceId);
        if (itemType == GOLD) revert GoldNotUsable(); // altın saklanır, harcanmaz
        uint256 id = items.tokenId(raceId, itemType); // geçersiz türde (>4) burada revert eder
        if (items.balanceOf(msg.sender, id) == 0) revert NoItem(raceId, itemType);

        items.burn(msg.sender, raceId, itemType);
        emit SkillUsed(raceId, msg.sender, itemType);
    }

    /// @notice Turu bitir. En hızlı mümkün turdan kısa sürede bitirilemez
    function finishRace(uint256 raceId) external {
        RaceInfo storage r = _activeRace(raceId);
        uint256 duration = block.timestamp - r.startTime;
        uint256 minimum = TRACK_LENGTH / MAX_SPEED; // en yüksek hızla bir tur (sn)
        if (duration + TIME_TOLERANCE < minimum) revert FinishTooEarly(duration, minimum);

        r.finishTime = uint64(block.timestamp);
        emit RaceFinished(raceId, msg.sender, duration, r.collectedCount, r.goldCount);
    }

    /// @notice Bu yarışta index'teki token toplandı mı?
    function isCollected(uint256 raceId, uint256 index) external view returns (bool) {
        if (index >= ITEMS_PER_RACE) return false;
        return races[raceId].collectedMask & (uint64(1) << uint64(index)) != 0;
    }
}
