// Mermaid in and out, without a browser: the Mermaid an LLM writes reads in
// right, what the tool writes reads back the same, and a pasted diagram is
// laid out sensibly. PASS / FAIL per check.
//   node test.js
const fs = require('fs');
const vm = require('vm');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/diagram.js', 'utf8') +
  '\nthis.parseMermaid = parseMermaid; this.toMermaid = toMermaid; this.quoteLabel = quoteLabel; this.unquoteLabel = unquoteLabel;', ctx);
const { parseMermaid, toMermaid, quoteLabel, unquoteLabel } = ctx;

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ': ' + JSON.stringify(detail)));
  if (!ok) failed++;
};
const edges = (d) => d.edges.map((e) => e.from + '>' + e.to + (e.label ? '|' + e.label : '')).join(' ');
const ids = (d) => d.nodes.map((n) => n.id).join(',');

// What LLMs write.
let d = parseMermaid('graph LR\n  A[Start] --> B --> C');
check('graph header and chained links', edges(d) === 'A>B B>C', edges(d));
d = parseMermaid('flowchart LR\n  A -- yes --> B\n  A -->|no| C');
check('both label forms', edges(d) === 'A>B|yes A>C|no', edges(d));
d = parseMermaid('flowchart LR\n  user-svc --> db-main');
check('ids with dashes', ids(d) === 'user-svc,db-main' && edges(d) === 'user-svc>db-main', [ids(d), edges(d)]);
d = parseMermaid('flowchart LR; A-->B; B-->C;');
check('semicolon-separated statements', edges(d) === 'A>B B>C', edges(d));
d = parseMermaid('flowchart LR\n  A["x;y"] --> B[a (b; c)]');
check('semicolons inside labels stay', d.nodes.map((n) => n.label).join('/') === 'x;y/a (b; c)', d.nodes.map((n) => n.label));
d = parseMermaid('---\ntitle: My flow\n---\nflowchart LR\n  A --> B');
check('front matter title kept, not a block', d.title === 'My flow' && ids(d) === 'A,B', [d.title, ids(d)]);
check('front matter title written back', parseMermaid(toMermaid(d)).title === 'My flow', toMermaid(d).slice(0, 40));
d = parseMermaid('flowchart LR\n  A["`**Bold**`"] --> B["`part **bold**`"]');
check('markdown labels', d.nodes[0].label === 'Bold' && d.nodes[0].bold && d.nodes[1].label === 'part bold' && !d.nodes[1].bold,
  d.nodes.map((n) => [n.label, n.bold]));
d = parseMermaid('flowchart LR\n  A:::hot --> B\n  classDef hot fill:#f96\n  click A "https://x.y"\n  linkStyle default stroke:red');
check('classDef, click and linkStyle default ignored', edges(d) === 'A>B' && ids(d) === 'A,B', [ids(d), edges(d)]);

d = parseMermaid('flowchart LR\n  A --o B\n  A --x C\n  A o--o D\n  A e1@--> E\n  e1@{ animate: true }');
check('circle, cross and named links keep both ends', edges(d) === 'A>B A>C A>D A>E' && ids(d) === 'A,B,C,D,E', [ids(d), edges(d)]);
d = parseMermaid('flowchart LR\n  A:::hot --> B --> C\n  class B cool\n  classDef hot fill:#f96\n  classDef cool fill:#9cf\n  style C fill:#9f9');
check('classDef colours reach their blocks', d.nodes.map((n) => n.fill).join() === '#f96,#9cf,#9f9', d.nodes.map((n) => n.fill));
d = parseMermaid('flowchart TD\n  A --> B\n  A --> C\n  A --> D\n  A --> E');
check('a wide fan-out stays top-down', /^flowchart TD/.test(toMermaid(d)), toMermaid(d).split('\n')[0]);

d = parseMermaid('Here is your diagram:\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nIt shows A feeding B.');
check('a whole LLM reply gives its fenced diagram', edges(d) === 'A>B', edges(d));
let refused = '';
try { parseMermaid('sequenceDiagram\n  A->>B: hi'); } catch (e) { refused = e.message; }
check('another diagram type is named when refused', /sequenceDiagram/.test(refused), refused);

d = parseMermaid('flowchart TB\n  LB --> Svc\n  subgraph Svc[Services]\n    direction LR\n    A ~~~ B ~~~ C\n  end\n  Svc --> DB');
const at = (id) => d.nodes.find((n) => n.id === id);
check('invisible links keep their blocks and draw nothing', ids(d) === 'LB,A,B,C,DB' && edges(d) === 'LB>Svc Svc>DB', [ids(d), edges(d)]);
check("a subgraph's own direction lays it out (a row in a top-down diagram)", at('A').y === at('B').y && at('B').y === at('C').y && at('A').x < at('B').x,
  d.nodes.map((n) => [n.id, n.x, n.y]));
check('a subgraph direction is written back', /subgraph Svc\["Services"\]\n    direction LR/.test(toMermaid(d)), toMermaid(d));

// Groups.
d = parseMermaid('flowchart TB\n  subgraph Outer\n    subgraph Inner\n      A --> B\n    end\n    C\n  end\n  D --> Inner');
const g = (id) => d.groups.find((x) => x.id === id);
check('nested subgraphs nest', g('Inner').parent === 'Outer' && g('Inner').members.join() === 'A,B' && g('Outer').members.join() === 'C',
  d.groups.map((x) => [x.id, x.parent, x.members]));
check('a link to a subgraph goes to the group, not a new block', edges(d).includes('D>Inner') && !d.nodes.some((n) => n.id === 'Inner'), [ids(d), edges(d)]);
const o = g('Outer');
const i = g('Inner');
check('outer box contains inner box', o.x < i.x && o.y < i.y && o.x + o.w > i.x + i.w && o.y + o.h > i.y + i.h, [o, i]);
const boxes = d.groups.filter((x) => !x.parent);
check('top-level groups and blocks do not overlap', d.nodes.filter((n) => n.id === 'D').every((n) =>
  boxes.every((b) => n.x + n.w <= b.x || n.x >= b.x + b.w || n.y + n.h <= b.y || n.y >= b.y + b.h)), [d.nodes, boxes]);

// Round trips: what the tool writes reads back to the same text.
const SAMPLES = [
  'flowchart LR\n  PC --> IMEM[(Instr memory)]\n  IMEM -->|instr| DEC\n  DEC --> RF\n  RF -->|rs1| ALU{{ALU}}\n  ALU ==> PC\n  ALU --> DMEM[(Data memory)]\n  DMEM -.->|load| RF',
  'flowchart TD\n  A([Start]) --> B[Enter]\n  B --> C{Valid?}\n  C -->|No| D[Error]\n  D --> B\n  C -->|Yes| E[Done]',
  'flowchart TB\n  subgraph Cloud\n    subgraph VPC\n      App --> DB[(DB)]\n    end\n  end\n  User --> Cloud',
  'flowchart LR\n  J1@{ shape: sm-circ } --> Q@{ shape: h-cyl, label: "FIFO" }\n  S@{ shape: cross-circ } --> J1',
  'flowchart LR\n  U@{ shape: person, label: "User" } --> W@{ shape: cloud, label: "Internet" } --> D@{ shape: lin-cyl, label: "Disk" }\n  W --> X@{ shape: fr-circ }\n  N@{ shape: brace, label: "a note" }',
];
d = parseMermaid('flowchart LR\n  A@{ shape: database } --> B@{ shape: comment, label: "x" } --> C@{ shape: stop } --> E@{ shape: directory, label: "f" }');
check('Mermaid 11 aliases read as their shapes', d.nodes.map((n) => n.shape).join() === 'cylinder,brace,stop,folder', d.nodes.map((n) => n.shape));
d = parseMermaid('flowchart LR\n  A@{ shape: cloud } --> B\n  A@{ label: "Net" }');
check('a later @{ label } keeps the shape', d.nodes[0].shape === 'cloud' && d.nodes[0].label === 'Net', d.nodes[0]);
for (const src of SAMPLES) {
  const out = toMermaid(parseMermaid(src));
  check('round trip: ' + src.split('\n')[1].trim(), toMermaid(parseMermaid(out)) === out, out);
}

// Layout of pasted Mermaid: a loop doesn't fling blocks out, and is cut at its feedback arrow.
d = parseMermaid(SAMPLES[0]);
const span = Math.max(...d.nodes.map((n) => n.x + n.w)) - Math.min(...d.nodes.map((n) => n.x));
check('a loop stays compact', span < 2000, span);
const x = (id) => d.nodes.find((n) => n.id === id).x;
check('the feedback arrow is the one cut (PC first, ALU after RF)', x('PC') < x('IMEM') && x('RF') < x('ALU'), d.nodes.map((n) => [n.id, n.x]));
d = parseMermaid('flowchart TD\n  A --> B\n  B --> C{ok?}\n  C -->|No| D\n  D --> B\n  C -->|Yes| E --> F{again?}\n  F -->|No| D\n  F -->|Yes| G');
const y = (id) => d.nodes.find((n) => n.id === id).y;
check('an error step sits beside the check that leads to it, not at the bottom', y('D') === y('E'), d.nodes.map((n) => [n.id, n.y]));

// Labels: written as typed, escaped only where Mermaid would misread them.
for (const [text, want] of [['Attempts >= 3?', '"Attempts >= 3?"'], ['C# code', '"C# code"'], ['a|b', '"a|b"'],
  ['say "hi"', '"say #quot;hi#quot;"'], ['<b>x</b>', '"#lt;b>x#lt;/b>"'], ['#42; x', '"#35;42; x"'], ['two\nlines', '"two<br/>lines"']]) {
  check('label ' + JSON.stringify(text), quoteLabel(text) === want && unquoteLabel(want) === text, [quoteLabel(text), unquoteLabel(want)]);
}
check('older escapes still read', unquoteLabel('"a #gt; b #124; c"') === 'a > b | c', unquoteLabel('"a #gt; b #124; c"'));

// For an LLM: symbols named, blocks in flow order.
d = parseMermaid('flowchart LR\n  A --> J1@{ shape: sm-circ }\n  J1 --> S@{ shape: cross-circ }\n  H{{Hex}} --> A');
const out = toMermaid(d);
check('junction and summing junction named in a comment', /%% .*J1 is a wire junction.*S is a summing junction/.test(out), out.split('\n')[1]);
check('a plain hexagon is not called a bus', !/H is a/.test(out), out.split('\n')[1]);

console.log(failed ? failed + ' failed' : 'all passed');
process.exitCode = failed ? 1 : 0;
