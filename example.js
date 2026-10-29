export const example = {
  graph: {
    id: "publishing-pipeline",
    label: "Publishing pipeline",
    directed: true,
    metadata: {
      description: "An illustrative document workflow. Select a node to explore its metadata."
    },
    nodes: {
      draft: { label: "Draft", metadata: { owner: "Author", stage: "Write" } },
      review: { label: "Review", metadata: { owner: "Editor", stage: "Check" } },
      revise: { label: "Revise", metadata: { owner: "Author", stage: "Write" } },
      approved: { label: "Approved", metadata: { owner: "Editor", stage: "Ready" } },
      publish: { label: "Publish", metadata: { owner: "Publisher", stage: "Release" } },
      archive: { label: "Archive", metadata: { owner: "Publisher", stage: "Preserve" } }
    },
    edges: [
      { source: "draft", target: "review", relation: "submit" },
      { source: "review", target: "revise", relation: "changes requested" },
      { source: "revise", target: "review", relation: "resubmit" },
      { source: "review", target: "approved", relation: "accept" },
      { source: "approved", target: "publish", relation: "release" },
      { source: "publish", target: "archive", relation: "preserve" }
    ]
  }
};

const socialNetwork = {
  graph: {
    id: "book-club",
    label: "Book club friendships",
    directed: false,
    metadata: { description: "An undirected graph. Edges have no arrowheads; isolated members show up in the summary." },
    nodes: {
      ana: { label: "Ana", metadata: { joined: 2019 } },
      ben: { label: "Ben", metadata: { joined: 2020 } },
      chloe: { label: "Chloé", metadata: { joined: 2019 } },
      dev: { label: "Dev", metadata: { joined: 2021 } },
      eli: { label: "Eli", metadata: { joined: 2022 } },
      fran: { label: "Fran", metadata: { joined: 2023, note: "Not connected yet" } }
    },
    edges: [
      { source: "ana", target: "ben", relation: "friends" },
      { source: "ana", target: "chloe", relation: "friends" },
      { source: "ben", target: "chloe", relation: "siblings" },
      { source: "chloe", target: "dev", relation: "colleagues" },
      { source: "dev", target: "eli", relation: "friends" }
    ]
  }
};

const stateMachine = {
  graph: {
    id: "traffic-light",
    label: "Pedestrian crossing",
    directed: true,
    metadata: { description: "Self-loops and parallel edges between the same pair of nodes." },
    nodes: {
      red: { label: "Red" },
      redAmber: { label: "Red + amber" },
      green: { label: "Green" },
      amber: { label: "Amber" },
      fault: { label: "Flashing amber", metadata: { safe: false } }
    },
    edges: [
      { id: "t1", source: "red", target: "redAmber", relation: "timer" },
      { id: "t2", source: "redAmber", target: "green", relation: "timer" },
      { id: "t3", source: "green", target: "amber", relation: "button pressed" },
      { id: "t4", source: "green", target: "amber", relation: "timer" },
      { id: "t5", source: "amber", target: "red", relation: "timer" },
      { id: "t6", source: "green", target: "green", relation: "no request" },
      { id: "t7", source: "amber", target: "fault", relation: "lamp failure" },
      { id: "t8", source: "fault", target: "red", relation: "reset" }
    ]
  }
};

const multipleGraphs = {
  graphs: [
    {
      id: "v1",
      label: "Network — January",
      directed: false,
      nodes: { a: { label: "London" }, b: { label: "Paris" }, c: { label: "Brussels" } },
      edges: [{ source: "a", target: "b" }, { source: "b", target: "c" }]
    },
    {
      id: "v2",
      label: "Network — June",
      directed: false,
      nodes: { a: { label: "London" }, b: { label: "Paris" }, c: { label: "Brussels" }, d: { label: "Amsterdam" } },
      edges: [{ source: "a", target: "b" }, { source: "b", target: "c" }, { source: "c", target: "d" }, { source: "a", target: "c" }]
    }
  ]
};

const directedHyperedges = {
  graph: {
    id: "photosynthesis",
    label: "Reactions",
    directed: true,
    metadata: { description: "Directed hyperedges join several sources to several targets. Each appears as a diamond junction." },
    nodes: {
      co2: { label: "CO₂" }, h2o: { label: "H₂O" }, light: { label: "Light" },
      glucose: { label: "Glucose" }, o2: { label: "O₂" }, atp: { label: "ATP" }
    },
    hyperedges: [
      { source: ["co2", "h2o", "light"], target: ["glucose", "o2"], relation: "photosynthesis" },
      { source: ["glucose", "o2"], target: ["co2", "h2o", "atp"], relation: "respiration" }
    ]
  }
};

const undirectedHyperedges = {
  graph: {
    id: "papers",
    label: "Co-authorship",
    directed: false,
    metadata: { description: "Undirected hyperedges list their members in \"nodes\": one hyperedge per paper." },
    nodes: { kim: { label: "Kim" }, lee: { label: "Lee" }, ngo: { label: "Ngo" }, ola: { label: "Ola" }, pat: { label: "Pat" } },
    hyperedges: [
      { nodes: ["kim", "lee", "ngo"], label: "Graph layouts (2021)" },
      { nodes: ["ngo", "ola"], label: "Schema design (2022)" },
      { nodes: ["kim", "ola", "pat"], label: "Validation (2024)" }
    ]
  }
};

// Deterministic, so it looks the same every time. Above 500 nodes the preview switches to compact mode.
function largeGraph(count = 800) {
  const nodes = {};
  const edges = [];
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let index = 0; index < count; index++) {
    nodes[`n${index}`] = { label: `Node ${index}` };
    if (index) edges.push({ source: `n${Math.floor(random() * index)}`, target: `n${index}` });
  }
  return { graph: { id: "large", label: `Large graph (${count} nodes)`, directed: false, metadata: { description: "Above 500 nodes the preview switches to compact mode: dots only, sfdp layout." }, nodes, edges } };
}

const brokenText = `{
  "graph": {
    "label": "Order process",
    "directed": "true",
    "nodes": {
      "cart": { "label": "Cart" },
      "checkout": { "label": "Checkout", "colour": "blue" },
      "paid": { "label": "Paid" }
    },
    "edges": [
      { "sorce": "cart", "target": "checkout" },
      { "source": "checkout", "target": "Paid" },
      { "source": "paid", "target": "shipped" }
    ]
  }
}
`;

const syntaxErrorText = `{
  "graph": {
    "nodes": {
      "a": { "label": "Start" },
      "b": { "label": "End" },
    },
    "edges": [
      { "source": "a", "target": "b" }
    ]
  }
}
`;

const v1Document = {
  graph: {
    label: "Version 1 document",
    directed: true,
    nodes: [
      { id: "a", label: "Alpha", type: "service" },
      { id: "b", label: "Beta", type: "database" },
      { id: "c", label: "Gamma" }
    ],
    edges: [
      { source: "a", target: "b", relation: "reads" },
      { source: "a", target: "c", relation: "calls" }
    ]
  }
};

const json = document => `${JSON.stringify(document, null, 2)}\n`;

/** Menu entries. "kind" groups them: valid documents, then documents for practising debugging. */
export const examples = [
  { id: "pipeline", name: "Publishing pipeline", file: "pipeline.json", kind: "valid", text: json(example) },
  { id: "social", name: "Undirected friendships", file: "friendships.json", kind: "valid", text: json(socialNetwork) },
  { id: "state-machine", name: "State machine with loops", file: "traffic-light.json", kind: "valid", text: json(stateMachine) },
  { id: "multiple", name: "Multiple graphs", file: "network-versions.json", kind: "valid", text: json(multipleGraphs) },
  { id: "hyper-directed", name: "Directed hyperedges", file: "reactions.json", kind: "valid", text: json(directedHyperedges) },
  { id: "hyper-undirected", name: "Undirected hyperedges", file: "co-authorship.json", kind: "valid", text: json(undirectedHyperedges) },
  { id: "large", name: "Large graph (800 nodes)", file: "large.json", kind: "valid", text: json(largeGraph()) },
  { id: "broken", name: "Schema errors to fix", file: "broken.json", kind: "debug", text: brokenText },
  { id: "syntax", name: "JSON syntax error", file: "syntax-error.json", kind: "debug", text: syntaxErrorText },
  { id: "v1", name: "JSON Graph v1 document", file: "v1.json", kind: "debug", text: json(v1Document) }
];
