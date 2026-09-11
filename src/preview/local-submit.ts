// The response sandbox disallows forms before Chromium emits `submit`, even
// for an entirely local demonstration. Forward only a real submit-button
// activation as a synthetic page event. No native submission, navigation,
// form data, page API or IPC is introduced; CSP and network guards stay intact.
export function installLocalSubmit(root: Document): void {
  const view = root.defaultView!;
  const active = new WeakSet<HTMLFormElement>();
  view.addEventListener('click', (event: MouseEvent) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const button = event.composedPath().find(value => value instanceof HTMLButtonElement || value instanceof HTMLInputElement);
    if (!(button instanceof HTMLButtonElement || button instanceof HTMLInputElement)
      || button.type !== 'submit' || button.matches(':disabled') || button.getRootNode() !== root) return;
    const form = button.form;
    if (!form || !form.isConnected || form.ownerDocument !== root || active.has(form)) return;
    event.preventDefault();
    const noValidate = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'noValidate')!.get!.call(form);
    if (!noValidate && !button.formNoValidate && !HTMLFormElement.prototype.reportValidity.call(form)) return;
    active.add(form);
    try { EventTarget.prototype.dispatchEvent.call(form, new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: button })); }
    finally { active.delete(form); }
  });
}
