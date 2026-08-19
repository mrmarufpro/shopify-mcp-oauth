import { describe, expect, it, vi } from "vitest";
import { retry } from "./retry";

describe("retry", () => {
  it("returns the first result without trying again", async () => {
    const operation = vi.fn().mockResolvedValue("downloaded");

    await expect(retry(operation)).resolves.toBe("downloaded");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps going until the operation succeeds", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("connection reset")).mockResolvedValue("downloaded");

    await expect(retry(operation)).resolves.toBe("downloaded");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured attempts and rethrows the last failure", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("connection reset"));

    await expect(retry(operation, { attempts: 3 })).rejects.toThrow("connection reset");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("refuses an attempt count that would never run the operation", async () => {
    const operation = vi.fn();

    await expect(retry(operation, { attempts: 0 })).rejects.toThrow(/at least one attempt/);
    expect(operation).not.toHaveBeenCalled();
  });
});
