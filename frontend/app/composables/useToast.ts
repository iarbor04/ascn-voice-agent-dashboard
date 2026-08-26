export function useToast() {
  const message = useState<string>("toast-message", () => "");
  let timer: ReturnType<typeof setTimeout> | undefined;

  function notify(text: string) {
    message.value = text;
    if (import.meta.client) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { message.value = ""; }, 2800);
    }
  }

  return { message, notify };
}
