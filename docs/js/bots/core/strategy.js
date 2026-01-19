// js/bots/core/strategy.js
export const BOT_UTILITY_CFG = {
  // weights
  wLoot: 1.0,
  wDeny: 0.65,
  wTeam: 0.50,
  wRisk: 1.15,
  wResource: 0.70,
  wShare: 0.75, // invloed van sack-bonus op V(p)

  // thresholds
  dashPushThreshold: 6.2,
  panicStayRisk: 7.5,        // stayRisk (0-10) boven dit = paniek
  safeDashRisk: 3.0,         // dashRisk (0-10) onder dit = “veilig genoeg”
  burrowMinSafetyGain: 2.0,  // minimaal voordeel (stayRisk - burrowRisk)
  shiftMinGain: 1.8,         // minimaal utility voordeel om SHIFT te doen
  comboMinGain: 1.2,         // minimaal extra voordeel vs beste single
  holdHorizon: 2,            // bewaar counters als event binnen 1-2
  lookaheadN: 5,

  // EVs (ruw, maar stabiel)
  lootEV: 1.7,          // gemiddelde lootkaart (Egg=1, Hen=2, PrizeHen=3)
  actionCardEV: 0.9,    // gemiddelde waarde van 1 action card in hand

  // combo discount (kans dat je later nog een keer aan de beurt komt in OPS)
  comboSecondTurnBaseProb: 0.55,
};
