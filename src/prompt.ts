export function promptText(opts: {
  title: string;
  placeholder?: string;
  defaultValue?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "prompt-overlay";

    const box = document.createElement("div");
    box.className = "prompt-box";

    const title = document.createElement("div");
    title.className = "prompt-title";
    title.textContent = opts.title;

    const input = document.createElement("input");
    input.className = "prompt-input";
    input.type = "text";
    input.placeholder = opts.placeholder ?? "";
    input.value = opts.defaultValue ?? "";

    const actions = document.createElement("div");
    actions.className = "prompt-actions";

    const cancel = document.createElement("button");
    cancel.textContent = "Annuler";
    cancel.className = "prompt-cancel";

    const ok = document.createElement("button");
    ok.textContent = "OK";
    ok.className = "prompt-ok";

    actions.append(cancel, ok);
    box.append(title, input, actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(() => input.focus(), 0);

    const finish = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };

    cancel.addEventListener("click", () => finish(null));
    ok.addEventListener("click", () => finish(input.value.trim()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value.trim());
      else if (e.key === "Escape") finish(null);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
  });
}
