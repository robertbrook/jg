export const $ = id => document.getElementById(id);
export const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
export const button = (text, action, className) => {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
};
export const status = message => { $("status").textContent = message; };
export const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
export function save(content, type, name) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const link = element("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
