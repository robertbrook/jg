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
