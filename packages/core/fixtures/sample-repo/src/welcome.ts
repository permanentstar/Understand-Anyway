import { greet, type User } from "./user.js";

export function welcome(user: User): string {
  return `${greet(user)}, welcome!`;
}
