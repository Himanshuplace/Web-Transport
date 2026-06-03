/**
 * teams.js — IPL-inspired team and player data.
 *
 * WHY separate data from logic?
 *   Keeping static data here lets you swap in real API data later (e.g. from
 *   a cricket stats API) without touching the simulation engine.  The engine
 *   just calls `getRandomMatchup()` and gets two fully-formed teams.
 *
 * Player roles:
 *   WK  = Wicket-Keeper (bats top-7, can't bowl)
 *   BAT = Pure batsman (bats top-6)
 *   AR  = All-rounder (bats mid-order, can bowl)
 *   BOWL= Pure bowler  (bats last 4, must bowl)
 */

const TEAMS = [
  {
    id: 'MS', name: 'Mumbai Stars', shortName: 'MUS', color: '#005DA0',
    players: [
      { id: 'ms1',  name: 'Rohit Verma',    role: 'BAT',  battingPos: 1  },
      { id: 'ms2',  name: 'Ishan Malik',    role: 'WK',   battingPos: 2  },
      { id: 'ms3',  name: 'Suryesh Kumar',  role: 'BAT',  battingPos: 3  },
      { id: 'ms4',  name: 'Tilak Sharma',   role: 'BAT',  battingPos: 4  },
      { id: 'ms5',  name: 'Kieron Roy',     role: 'AR',   battingPos: 5  },
      { id: 'ms6',  name: 'Hardik Pandiya', role: 'AR',   battingPos: 6  },
      { id: 'ms7',  name: 'Krunal Rao',     role: 'AR',   battingPos: 7  },
      { id: 'ms8',  name: 'Jasprit Jha',    role: 'BOWL', battingPos: 8  },
      { id: 'ms9',  name: 'Trent Bolt',     role: 'BOWL', battingPos: 9  },
      { id: 'ms10', name: 'Piyush Chohan',  role: 'BOWL', battingPos: 10 },
      { id: 'ms11', name: 'Mohit Sharma',   role: 'BOWL', battingPos: 11 },
    ],
  },
  {
    id: 'CK', name: 'Chennai Kings', shortName: 'CHK', color: '#F9CD05',
    players: [
      { id: 'ck1',  name: 'Devon Conway',   role: 'WK',   battingPos: 1  },
      { id: 'ck2',  name: 'Rutu Gaikwad',   role: 'BAT',  battingPos: 2  },
      { id: 'ck3',  name: 'Ambati Raya',    role: 'BAT',  battingPos: 3  },
      { id: 'ck4',  name: 'Ajinkya Dhoni',  role: 'BAT',  battingPos: 4  },
      { id: 'ck5',  name: 'MS Raina',       role: 'BAT',  battingPos: 5  },
      { id: 'ck6',  name: 'Shivam Dube',    role: 'AR',   battingPos: 6  },
      { id: 'ck7',  name: 'Ravindra Jades', role: 'AR',   battingPos: 7  },
      { id: 'ck8',  name: 'Deepak Chahar',  role: 'BOWL', battingPos: 8  },
      { id: 'ck9',  name: 'Mitchell Sant',  role: 'BOWL', battingPos: 9  },
      { id: 'ck10', name: 'Tushar Deshp',   role: 'BOWL', battingPos: 10 },
      { id: 'ck11', name: 'Matheesha Path', role: 'BOWL', battingPos: 11 },
    ],
  },
  {
    id: 'BR', name: 'Bangalore Riders', shortName: 'BGR', color: '#EC1C24',
    players: [
      { id: 'br1',  name: 'Virat Kholi',    role: 'BAT',  battingPos: 1  },
      { id: 'br2',  name: 'Faf Du Pless',   role: 'BAT',  battingPos: 2  },
      { id: 'br3',  name: 'Glenn Max-Well',  role: 'AR',   battingPos: 3  },
      { id: 'br4',  name: 'Rajat Patid',    role: 'BAT',  battingPos: 4  },
      { id: 'br5',  name: 'Dinesh Kar',     role: 'WK',   battingPos: 5  },
      { id: 'br6',  name: 'Shahbaz Ahmad',  role: 'AR',   battingPos: 6  },
      { id: 'br7',  name: 'Mahipal Lom',    role: 'AR',   battingPos: 7  },
      { id: 'br8',  name: 'Harshal Pat',    role: 'BOWL', battingPos: 8  },
      { id: 'br9',  name: 'Mohammed Siraj', role: 'BOWL', battingPos: 9  },
      { id: 'br10', name: 'Reece Topley',   role: 'BOWL', battingPos: 10 },
      { id: 'br11', name: 'Karn Sharma',    role: 'BOWL', battingPos: 11 },
    ],
  },
  {
    id: 'KW', name: 'Kolkata Warriors', shortName: 'KKW', color: '#3A225D',
    players: [
      { id: 'kw1',  name: 'Jason Roy',      role: 'BAT',  battingPos: 1  },
      { id: 'kw2',  name: 'Sunil Nar',      role: 'AR',   battingPos: 2  },
      { id: 'kw3',  name: 'Shreyas Iyer',   role: 'BAT',  battingPos: 3  },
      { id: 'kw4',  name: 'Nitish Rana',    role: 'BAT',  battingPos: 4  },
      { id: 'kw5',  name: 'Rinku Singh',    role: 'BAT',  battingPos: 5  },
      { id: 'kw6',  name: 'Andre Russell',  role: 'AR',   battingPos: 6  },
      { id: 'kw7',  name: 'Rahm Shah',      role: 'WK',   battingPos: 7  },
      { id: 'kw8',  name: 'Varun Chakra',   role: 'BOWL', battingPos: 8  },
      { id: 'kw9',  name: 'Tim Southee',    role: 'BOWL', battingPos: 9  },
      { id: 'kw10', name: 'Umesh Yadav',    role: 'BOWL', battingPos: 10 },
      { id: 'kw11', name: 'Harshit Rana',   role: 'BOWL', battingPos: 11 },
    ],
  },
  {
    id: 'DC', name: 'Delhi Capitals', shortName: 'DLC', color: '#0078BC',
    players: [
      { id: 'dc1',  name: 'David Warner',   role: 'BAT',  battingPos: 1  },
      { id: 'dc2',  name: 'Prithvi Shaw',   role: 'BAT',  battingPos: 2  },
      { id: 'dc3',  name: 'Ricky Powell',   role: 'BAT',  battingPos: 3  },
      { id: 'dc4',  name: 'Triston Stubbs', role: 'BAT',  battingPos: 4  },
      { id: 'dc5',  name: 'Axar Patel',     role: 'AR',   battingPos: 5  },
      { id: 'dc6',  name: 'Lalit Yadav',    role: 'AR',   battingPos: 6  },
      { id: 'dc7',  name: 'Sanju Samson',   role: 'WK',   battingPos: 7  },
      { id: 'dc8',  name: 'Anrich Nortje',  role: 'BOWL', battingPos: 8  },
      { id: 'dc9',  name: 'Kuldeep Yadav',  role: 'BOWL', battingPos: 9  },
      { id: 'dc10', name: 'Kamlesh Nag',    role: 'BOWL', battingPos: 10 },
      { id: 'dc11', name: 'Ishant Sharma',  role: 'BOWL', battingPos: 11 },
    ],
  },
  {
    id: 'PL', name: 'Punjab Lions', shortName: 'PNL', color: '#ED1B24',
    players: [
      { id: 'pl1',  name: 'Shikhar Dhaw',   role: 'BAT',  battingPos: 1  },
      { id: 'pl2',  name: 'Jonny Bair',     role: 'BAT',  battingPos: 2  },
      { id: 'pl3',  name: 'Sam Curran',     role: 'AR',   battingPos: 3  },
      { id: 'pl4',  name: 'Liam Living',    role: 'AR',   battingPos: 4  },
      { id: 'pl5',  name: 'Jitesh Shar',    role: 'WK',   battingPos: 5  },
      { id: 'pl6',  name: 'Harpreet Bhati', role: 'BAT',  battingPos: 6  },
      { id: 'pl7',  name: 'Rishi Dhawan',   role: 'AR',   battingPos: 7  },
      { id: 'pl8',  name: 'Arshdeep Singh', role: 'BOWL', battingPos: 8  },
      { id: 'pl9',  name: 'Kagiso Rab',     role: 'BOWL', battingPos: 9  },
      { id: 'pl10', name: 'Rahul Chahar',   role: 'BOWL', battingPos: 10 },
      { id: 'pl11', name: 'Nathan Ellis',   role: 'BOWL', battingPos: 11 },
    ],
  },
];

const VENUES = [
  { name: 'Wankhede Stadium',     city: 'Mumbai'    },
  { name: 'M. A. Chidambaram',    city: 'Chennai'   },
  { name: 'M. Chinnaswamy',       city: 'Bangalore' },
  { name: 'Eden Gardens',         city: 'Kolkata'   },
  { name: 'Arun Jaitley Stadium', city: 'Delhi'     },
  { name: 'PCA Stadium',          city: 'Mohali'    },
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Returns up to `count` non-overlapping match pairs plus random venues.
 * Deep-clones teams so each match has independent mutable player objects.
 */
export function getMatchups(count) {
  const shuffled = shuffle(TEAMS);
  const matchups = [];
  for (let i = 0; i + 1 < shuffled.length && matchups.length < count; i += 2) {
    const team1 = JSON.parse(JSON.stringify(shuffled[i]));
    const team2 = JSON.parse(JSON.stringify(shuffled[i + 1]));
    const venue = VENUES[Math.floor(Math.random() * VENUES.length)];
    matchups.push({ team1, team2, venue });
  }
  return matchups;
}
