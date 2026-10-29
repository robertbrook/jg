// A draft-07 interpreter covering the keywords used by json-graph-schema_v2.json,
// built to explain failures (closest oneOf alternative, ambiguity) rather than only report them.

export const typeOf = value => value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
const matchesType = (value, type) => type === typeOf(value) || (type === "number" && typeOf(value) === "integer");
const object = value => typeOf(value) === "object";
const escape = key => String(key).replaceAll("~", "~0").replaceAll("/", "~1");
const unescape = key => key.replaceAll("~1", "/").replaceAll("~0", "~");

function equal(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b) || typeof a !== "object" || a === null) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

export function branchLabel(schema, root) {
  const target = schema.$ref ? resolve(root, schema.$ref) : schema;
  const properties = target.properties ?? {};
  if (properties.edges) return "graph with edges";
  if (properties.hyperedges) {
    return (properties.hyperedges.items?.$ref ?? "").includes("undirected")
      ? 'graph with undirected hyperedges (requires "directed": false)'
      : "graph with directed hyperedges";
  }
  if (properties.graph && target.required?.includes("graph")) return 'single-graph document { "graph": … }';
  if (properties.graphs) return 'multi-graph document { "graphs": [ … ] }';
  return schema.$ref ? schema.$ref.split("/").at(-1) : "alternative";
}

function resolve(root, ref) {
  if (!ref.startsWith("#")) throw new Error(`Unsupported remote $ref ${ref}`);
  return ref.slice(2).split("/").filter(Boolean).map(unescape).reduce((schema, key) => schema?.[key], root);
}

export function createValidator(root) {
  function validate(value, schema, instancePath = "", schemaPath = "#") {
    const errors = [];
    const fail = (keyword, detail = {}) => errors.push({ keyword, instancePath, schemaPath: `${schemaPath}/${keyword}`, value, ...detail });
    if (schema === true) return errors;
    if (schema === false) { fail("false"); return errors; }
    // In draft-07, keywords beside $ref are ignored.
    if (schema.$ref) return validate(value, resolve(root, schema.$ref), instancePath, schema.$ref);

    if (schema.enum && !schema.enum.some(option => equal(option, value))) fail("enum", { expected: schema.enum });
    if (Object.hasOwn(schema, "const") && !equal(schema.const, value)) fail("const", { expected: [schema.const] });
    if (schema.type !== undefined) {
      const types = [].concat(schema.type);
      if (!types.some(type => matchesType(value, type))) { fail("type", { expected: types, found: typeOf(value) }); return errors; }
    }
    if (object(value)) {
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail("required", { property: key, expected: schema.required });
      for (const [key, item] of Object.entries(value)) {
        const path = `${instancePath}/${escape(key)}`;
        if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...validate(item, schema.properties[key], path, `${schemaPath}/properties/${escape(key)}`));
        else if (schema.additionalProperties === false) fail("additionalProperties", { property: key, allowed: Object.keys(schema.properties ?? {}) });
        else if (object(schema.additionalProperties)) errors.push(...validate(item, schema.additionalProperties, path, `${schemaPath}/additionalProperties`));
      }
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) fail("minItems", { expected: schema.minItems });
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail("maxItems", { expected: schema.maxItems });
      if (object(schema.items) || typeof schema.items === "boolean") {
        value.forEach((item, index) => errors.push(...validate(item, schema.items, `${instancePath}/${index}`, `${schemaPath}/items`)));
      }
    }
    if (typeof value === "string") {
      if (schema.minLength !== undefined && [...value].length < schema.minLength) fail("minLength", { expected: schema.minLength });
      if (schema.maxLength !== undefined && [...value].length > schema.maxLength) fail("maxLength", { expected: schema.maxLength });
      if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) fail("pattern", { expected: schema.pattern });
    }
    for (const [index, sub] of (schema.allOf ?? []).entries()) errors.push(...validate(value, sub, instancePath, `${schemaPath}/allOf/${index}`));
    if (schema.anyOf) {
      const branches = schema.anyOf.map((sub, index) => branch(value, sub, instancePath, `${schemaPath}/anyOf/${index}`, index));
      if (!branches.some(item => item.passes)) fail("anyOf", { branches });
    }
    if (schema.oneOf) {
      const branches = schema.oneOf.map((sub, index) => branch(value, sub, instancePath, `${schemaPath}/oneOf/${index}`, index));
      const passing = branches.filter(item => item.passes);
      if (!passing.length) fail("oneOf", { branches });
      else if (passing.length > 1) fail("oneOf", { branches, ambiguous: true, passing: passing.map(item => item.index) });
      else errors.push(...passing[0].errors);
    }
    return errors;
  }
  function branch(value, schema, instancePath, schemaPath, index) {
    const errors = validate(value, schema, instancePath, schemaPath);
    // A branch whose only problems are nested ambiguities still describes the data; strict validity is tracked separately.
    return { index, schemaPath, label: branchLabel(schema, root), errors, passes: errors.every(error => error.ambiguous) };
  }
  return value => validate(value, root);
}

function size(value, limit = 1000) {
  let count = 1;
  if (value !== null && typeof value === "object") for (const item of Object.values(value)) {
    count += size(item, limit - count);
    if (count >= limit) break;
  }
  return count;
}

// Lower is closer. A property rejected at the alternative's own level leaves its whole subtree unexplained,
// so it costs as much as the data inside it; small mistakes deeper in the data cost 1 each.
export function branchScore(branch, instancePath) {
  return branch.errors.reduce((score, error) => {
    if (error.ambiguous) return score + 0.25;
    if (error.keyword === "oneOf" || error.keyword === "anyOf") return score + Math.min(...error.branches.map(item => branchScore(item, error.instancePath)));
    if (error.keyword === "additionalProperties" && error.instancePath === instancePath) return score + 1 + size(error.value[error.property]);
    return score + 1;
  }, 0);
}

export function closestBranch(error) {
  return [...error.branches].sort((a, b) => branchScore(a, error.instancePath) - branchScore(b, error.instancePath) || a.index - b.index)[0];
}
