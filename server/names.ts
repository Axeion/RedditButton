/**
 * Verb_Noun_### identity names.
 *
 * 120 verbs x 120 nouns x 900 numbers ~= 13M combinations, which keeps
 * collisions rare enough that the retry loop in identity.ts almost never runs.
 */

export const VERBS: readonly string[] = [
  'Circling', 'Whispering', 'Drifting', 'Lurking', 'Prowling', 'Waiting',
  'Watching', 'Fading', 'Burning', 'Falling', 'Rising', 'Howling',
  'Crawling', 'Sinking', 'Swaying', 'Twitching', 'Blinking', 'Grinning',
  'Stalking', 'Humming', 'Wandering', 'Shivering', 'Gliding', 'Creeping',
  'Racing', 'Dodging', 'Flinching', 'Holding', 'Clutching', 'Gasping',
  'Chasing', 'Ducking', 'Weaving', 'Bracing', 'Leaping', 'Stumbling',
  'Reeling', 'Spinning', 'Coasting', 'Lingering', 'Hovering', 'Dashing',
  'Skulking', 'Trembling', 'Snarling', 'Yawning', 'Squinting', 'Nodding',
  'Panting', 'Sighing', 'Muttering', 'Grumbling', 'Chuckling', 'Shrugging',
  'Pacing', 'Stomping', 'Tiptoeing', 'Vaulting', 'Diving', 'Surfacing',
  'Scattering', 'Gathering', 'Sorting', 'Counting', 'Guessing', 'Betting',
  'Bluffing', 'Stalling', 'Rushing', 'Sprinting', 'Jogging', 'Ambling',
  'Loitering', 'Idling', 'Fidgeting', 'Tapping', 'Drumming', 'Strumming',
  'Whistling', 'Singing', 'Shouting', 'Bellowing', 'Croaking', 'Squawking',
  'Chirping', 'Buzzing', 'Rattling', 'Clanking', 'Grinding', 'Churning',
  'Simmering', 'Boiling', 'Freezing', 'Thawing', 'Melting', 'Glowing',
  'Flickering', 'Sparking', 'Smouldering', 'Steaming', 'Drizzling', 'Pouring',
  'Flooding', 'Draining', 'Ebbing', 'Surging', 'Cresting', 'Breaking',
  'Bending', 'Twisting', 'Coiling', 'Winding', 'Unravelling', 'Fraying',
  'Splitting', 'Cracking', 'Shattering', 'Mending', 'Patching', 'Stitching',
];

export const NOUNS: readonly string[] = [
  'Magpie', 'Otter', 'Vulture', 'Beacon', 'Anchor', 'Lantern',
  'Ferret', 'Heron', 'Badger', 'Comet', 'Kettle', 'Marmot',
  'Falcon', 'Weasel', 'Raven', 'Sparrow', 'Kestrel', 'Osprey',
  'Lynx', 'Jackal', 'Meerkat', 'Pangolin', 'Aardvark', 'Wombat',
  'Gecko', 'Iguana', 'Viper', 'Cobra', 'Newt', 'Toad',
  'Salmon', 'Herring', 'Marlin', 'Urchin', 'Barnacle', 'Kraken',
  'Piston', 'Turbine', 'Bellows', 'Hammer', 'Anvil', 'Chisel',
  'Compass', 'Sextant', 'Pendulum', 'Flywheel', 'Ratchet', 'Spindle',
  'Kettledrum', 'Cymbal', 'Fiddle', 'Banjo', 'Tuba', 'Ocarina',
  'Teapot', 'Skillet', 'Ladle', 'Colander', 'Thimble', 'Spatula',
  'Beetle', 'Cricket', 'Firefly', 'Moth', 'Hornet', 'Mantis',
  'Boulder', 'Pebble', 'Geyser', 'Glacier', 'Canyon', 'Dune',
  'Thunder', 'Cyclone', 'Monsoon', 'Blizzard', 'Mirage', 'Aurora',
  'Harbour', 'Lighthouse', 'Trawler', 'Schooner', 'Dinghy', 'Buoy',
  'Turnip', 'Radish', 'Parsnip', 'Artichoke', 'Gherkin', 'Kumquat',
  'Walnut', 'Acorn', 'Thistle', 'Bramble', 'Fern', 'Lichen',
  'Cobblestone', 'Drawbridge', 'Turret', 'Belfry', 'Cellar', 'Attic',
  'Satchel', 'Trinket', 'Locket', 'Monocle', 'Umbrella', 'Galosh',
  'Domino', 'Marble', 'Yo-yo', 'Kazoo', 'Puzzle', 'Lantern-Fish',
  'Pylon', 'Gantry', 'Trestle', 'Culvert', 'Aqueduct', 'Silo',
];

const rand = (n: number) => Math.floor(Math.random() * n);

export function generateName(): string {
  const verb = VERBS[rand(VERBS.length)]!;
  const noun = NOUNS[rand(NOUNS.length)]!;
  const num = 100 + rand(900);
  return `${verb}_${noun}_${num}`;
}

export const NAME_SPACE_SIZE = VERBS.length * NOUNS.length * 900;
