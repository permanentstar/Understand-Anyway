function pad(value, width = 2) {
  return String(Math.trunc(Math.abs(value))).padStart(width, "0");
}

export function formatLocalTimestamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainderMinutes = pad(Math.abs(offsetMinutes) % 60);
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
    `${offsetSign}${offsetHours}:${offsetRemainderMinutes}`,
  ].join("");
}
