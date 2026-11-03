/**
 * What you have to do to get paid.
 *
 * Each question belongs to a job and is about the thing that job actually
 * involves — a marshal is asked about flags, someone selling a setup is
 * asked what causes understeer. That makes a shift worth reading rather
 * than worth clicking through, and it means the economy pays people for
 * knowing the sport instead of for owning a timer.
 *
 * `answer` is an index into `options`. Keep options under about forty
 * characters: Discord truncates a button label and a truncated answer is
 * an unfair question.
 *
 * Admins can add jobs the panel does not know about, so anything without
 * questions of its own falls back to the general pool below.
 */

const Q = {
  marshal: [
    { prompt: 'A car is stopped off-line with its driver still inside. Which flag?',
      options: ['Yellow', 'Red', 'Blue', 'Black'], answer: 0,
      note: 'Yellow means danger ahead — slow down and no overtaking.' },
    { prompt: 'A leader is coming up to lap a car in front. Which flag does the slower car get?',
      options: ['Blue', 'White', 'Yellow', 'Green'], answer: 0,
      note: 'Blue tells a driver being lapped to let the faster car through.' },
    { prompt: 'The session has been stopped. Which flag is shown?',
      options: ['Red', 'Yellow', 'Black and white', 'Chequered'], answer: 0,
      note: 'Red stops the session; everyone slows and comes back to the pits.' },
    { prompt: 'A driver has been warned once for track limits. What comes next?',
      options: ['Black and white', 'Blue', 'Green', 'White'], answer: 0,
      note: 'The black-and-white diagonal is the final warning before a penalty.' },
    { prompt: 'There is oil on the racing line. Which flag?',
      options: ['Yellow with red stripes', 'Solid red', 'White', 'Blue'], answer: 0,
      note: 'Red-striped yellow warns of a slippery surface.' },
  ],
  setup: [
    { prompt: 'The car understeers on the way into a corner. What helps?',
      options: ['Soften the front', 'Stiffen the front', 'More rear wing', 'Raise tyre pressures'],
      answer: 0, note: 'Softening the front lets it bite; stiffening it makes understeer worse.' },
    { prompt: 'The rear steps out under braking. What helps?',
      options: ['Move brake bias forward', 'Move it rearward', 'Less front wing', 'Lower the rear'],
      answer: 0, note: 'Bias forward keeps the rear axle from locking and stepping out.' },
    { prompt: 'The car is quick in a straight line but slow through corners. What is likely?',
      options: ['Too little wing', 'Too much wing', 'Gearing too short', 'Tyres too hot'],
      answer: 0, note: 'Low downforce buys you straight-line speed and costs you cornering.' },
    { prompt: 'Front tyres are overheating on a long run. What helps?',
      options: ['Less front camber', 'More front camber', 'Stiffer front bar', 'Shorter gearing'],
      answer: 0, note: 'Too much camber loads one edge of the tyre and cooks it.' },
    { prompt: 'The car bottoms out over kerbs. What helps?',
      options: ['Raise the ride height', 'Lower it', 'Soften the springs', 'More rake'],
      answer: 0, note: 'If it is hitting the ground, give it somewhere to go.' },
  ],
  pitcrew: [
    { prompt: 'Which comes first in a standard stop?',
      options: ['Car on jacks', 'Wheels off', 'Wheels on', 'Car down'], answer: 0,
      note: 'Jacks first, every time — nothing else can start until it is off the ground.' },
    { prompt: 'The wheel gun has not clicked home. What do you do?',
      options: ['Hold the car', 'Wave it out', 'Drop the jack', 'Step back'], answer: 0,
      note: 'An unsecured wheel leaving the box is how people get hurt.' },
    { prompt: 'What is an unsafe release?',
      options: ['Letting a car go into traffic', 'Stopping past the marks',
                'A slow left rear', 'Stalling in the box'], answer: 0,
      note: 'Releasing a car into the path of another is a penalty and a danger.' },
    { prompt: 'Driver stops a metre long of the marks. What happens?',
      options: ['The crew moves to the car', 'The car reverses',
                'The stop is abandoned', 'The jack is thrown'], answer: 0,
      note: 'Reversing in the box is not allowed, so the crew goes to the car.' },
  ],
  detail: [
    { prompt: 'Which goes first when washing a car?',
      options: ['Wheels', 'Roof', 'Bonnet', 'Doors'], answer: 0,
      note: 'Wheels are the dirtiest — do them first so the brake dust goes nowhere else.' },
    { prompt: 'Why two buckets?',
      options: ['To keep grit out of the wash', 'To save water',
                'One for wax', 'To rinse twice'], answer: 0,
      note: 'One to wash, one to rinse the mitt, so the dirt never goes back on the paint.' },
    { prompt: 'What causes swirl marks in paint?',
      options: ['Wiping with a dirty cloth', 'Too much water',
                'Washing in the shade', 'Drying too slowly'], answer: 0,
      note: 'Trapped grit under a cloth scratches the clear coat.' },
  ],
  commentate: [
    { prompt: 'What is the undercut?',
      options: ['Pitting early to get ahead', 'Pitting late to get ahead',
                'Cutting a corner', 'Saving fuel'], answer: 0,
      note: 'Stop first, use fresh tyres, and be ahead when the other car stops.' },
    { prompt: 'What is dirty air?',
      options: ['Turbulence behind a car', 'A dusty track',
                'Air in the brakes', 'A rich fuel mix'], answer: 0,
      note: 'It costs the following car downforce, which is why following is hard.' },
    { prompt: 'A driver sets the fastest lap of the race. What is that called?',
      options: ['Purple', 'Green', 'Yellow', 'Gold'], answer: 0,
      note: 'Purple is the fastest overall; green is a personal best.' },
    { prompt: 'What is a stint?',
      options: ['A run between pit stops', 'A qualifying lap',
                'A formation lap', 'A penalty period'], answer: 0,
      note: 'One set of tyres, from leaving the pits to coming back in.' },
  ],
};

/** Anything an admin has invented gets general racing questions. */
const GENERAL = [
  { prompt: 'What does the chequered flag mean?',
    options: ['The session is over', 'One lap to go', 'Danger ahead', 'Pit now'], answer: 0,
    note: 'It is shown to the winner first and then to everyone still running.' },
  { prompt: 'What is a formation lap for?',
    options: ['Warming tyres and brakes', 'Setting the grid',
              'Checking fuel', 'Timing the start'], answer: 0,
    note: 'Cold tyres have almost no grip, and the first corner is no place to find that out.' },
  { prompt: 'What is a drive-through penalty?',
    options: ['Through the pit lane without stopping', 'Ten seconds stationary',
              'A lap deleted', 'Starting from the back'], answer: 0,
    note: 'You lose the time it takes to cross the pit lane at the limit.' },
  { prompt: 'What does P1 mean?',
    options: ['First place', 'First practice', 'One lap down', 'Pit lane one'], answer: 0,
    note: 'P for position. P1 is the lead.' },
  { prompt: 'Why do drivers weave behind a safety car?',
    options: ['To keep heat in the tyres', 'To look for damage',
              'To save fuel', 'To signal the pits'], answer: 0,
    note: 'Running slowly lets tyres cool, and cold tyres do not grip at the restart.' },
];

export const SHIFT_FALLBACK = GENERAL[0];

/**
 * A question for this job, with the options shuffled.
 *
 * The right answer is written first in every entry above, which makes the
 * table readable and would make the game trivial, so the order is mixed
 * here and the answer index moved to match.
 */
export function shiftQuestion(jobId, rng = Math.random) {
  const pool = Q[String(jobId)] || GENERAL;
  const picked = pool[Math.floor(rng() * pool.length)] || GENERAL[0];

  const tagged = picked.options.map((text, i) => ({ text, right: i === picked.answer }));
  for (let i = tagged.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [tagged[i], tagged[j]] = [tagged[j], tagged[i]];
  }
  return {
    prompt: picked.prompt,
    options: tagged.map(o => o.text),
    answer: tagged.findIndex(o => o.right),
    note: picked.note || '',
  };
}

/** Every question, for the tests that check the table itself. */
export const ALL_QUESTIONS = Object.entries(Q)
  .flatMap(([job, list]) => list.map(q => ({ ...q, job })))
  .concat(GENERAL.map(q => ({ ...q, job: 'general' })));
