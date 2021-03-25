import VM from "@nomiclabs/ethereumjs-vm";
import { EVMResult } from "@nomiclabs/ethereumjs-vm/dist/evm/evm";
import { InterpreterStep } from "@nomiclabs/ethereumjs-vm/dist/evm/interpreter";
import Message from "@nomiclabs/ethereumjs-vm/dist/evm/message";
import { Transaction } from "ethereumjs-tx";
import { BN, setLength, toBuffer } from "ethereumjs-util";

import { assertHardhatInvariant } from "../../core/errors";
import { InvalidInputError } from "../provider/errors";
import { RpcDebugTracingConfig } from "../provider/input";
import { RpcDebugTraceOutput, RpcStructLog } from "../provider/output";

// tslint:disable only-hardhat-error

interface StructLog {
  depth: number;
  gas: number;
  gasCost: number;
  op: string;
  pc: number;
  memory: string[];
  stack: string[];
  storage: Record<string, string>;
  memSize: number;
  error?: object;
}

type Storage = Record<string, string>;

interface DebugMessage {
  structLogs: Array<StructLog | DebugMessage>;
  to: string;
  result?: EVMResult;
}

type NestedStructLogs = Array<StructLog | NestedStructLogs>;

function isStructLog(
  message: StructLog | DebugMessage | undefined
): message is StructLog {
  return message !== undefined && !("structLogs" in message);
}

const EMPTY_MEMORY_WORD = "0".repeat(64);

export class VMDebugTracer {
  private _enabled = false;
  private _lastTrace?: RpcDebugTraceOutput;
  private _config: RpcDebugTracingConfig;

  private _messages: DebugMessage[] = [];
  private _addressToStorage: Record<string, Storage> = {};

  constructor(private readonly _vm: VM) {
    this._beforeMessageHandler = this._beforeMessageHandler.bind(this);
    this._afterMessageHandler = this._afterMessageHandler.bind(this);
    this._beforeTxHandler = this._beforeTxHandler.bind(this);
    this._stepHandler = this._stepHandler.bind(this);
    this._afterTxHandler = this._afterTxHandler.bind(this);
  }

  /**
   * Run the `action` callback and trace its execution
   */
  public async trace(
    action: () => Promise<void>,
    config: RpcDebugTracingConfig
  ): Promise<RpcDebugTraceOutput> {
    try {
      this._enableTracing(config);
      this._config = config;

      await action();

      return this._getDebugTrace();
    } finally {
      this._disableTracing();
    }
  }

  private _enableTracing(config: RpcDebugTracingConfig) {
    if (this._enabled) {
      return;
    }
    this._vm.on("beforeTx", this._beforeTxHandler);
    this._vm.on("beforeMessage", this._beforeMessageHandler);
    this._vm.on("step", this._stepHandler);
    this._vm.on("afterMessage", this._afterMessageHandler);
    this._vm.on("afterTx", this._afterTxHandler);
    this._enabled = true;
    this._config = config;
  }

  private _disableTracing() {
    if (!this._enabled) {
      return;
    }
    this._vm.removeListener("beforeTx", this._beforeTxHandler);
    this._vm.removeListener("beforeMessage", this._beforeMessageHandler);
    this._vm.removeListener("step", this._stepHandler);
    this._vm.removeListener("afterTx", this._afterTxHandler);
    this._vm.removeListener("afterMessage", this._afterMessageHandler);
    this._enabled = false;
    this._config = undefined;
  }

  private _getDebugTrace(): RpcDebugTraceOutput {
    if (this._lastTrace === undefined) {
      throw new Error(
        "No debug trace available. Please run the transaction first"
      );
    }
    return this._lastTrace;
  }

  private async _beforeTxHandler(_tx: Transaction, next: any) {
    this._lastTrace = undefined;
    this._messages = [];
    this._addressToStorage = {};
    next();
  }

  private async _beforeMessageHandler(message: Message, next: any) {
    const debugMessage: DebugMessage = {
      structLogs: [],
      to: message.to?.toString("hex") ?? "",
    };

    if (this._messages.length > 0) {
      const previousMessage = this._messages[this._messages.length - 1];

      previousMessage.structLogs.push(debugMessage);
    }

    this._messages.push(debugMessage);

    next();
  }

  private async _stepHandler(step: InterpreterStep, next: any) {
    assertHardhatInvariant(
      this._messages.length > 0,
      "Step handler should be called after at least one beforeMessage handler"
    );

    const structLog = await this._stepToStructLog(step);
    this._messages[this._messages.length - 1].structLogs.push(structLog);

    next();
  }

  private async _afterMessageHandler(result: EVMResult, next: any) {
    const lastMessage = this._messages[this._messages.length - 1];

    lastMessage.result = result;

    if (this._messages.length > 1) {
      this._messages.pop();
    }

    next();
  }

  private async _afterTxHandler(result: EVMResult, next: any) {
    const { default: flattenDeep } = await import("lodash/flattenDeep");
    const topLevelMessage = this._messages[0];

    const nestedStructLogs = await this._messageToNestedStructLogs(
      topLevelMessage,
      topLevelMessage.to
    );

    const rpcStructLogs: RpcStructLog[] = flattenDeep(nestedStructLogs).map(
      (structLog) => {
        const rpcStructLog: RpcStructLog = structLog;

        // geth doesn't return this value
        delete rpcStructLog.memSize;

        if (this._config?.disableMemory === true) {
          delete rpcStructLog.memory;
        }
        if (this._config?.disableStack === true) {
          delete rpcStructLog.stack;
        }
        if (this._config?.disableStorage === true) {
          delete rpcStructLog.storage;
        }

        return rpcStructLog;
      }
    );

    // geth does this for some reason
    if (result.execResult.exceptionError?.error === "out of gas") {
      rpcStructLogs[rpcStructLogs.length - 1].error = {};
    }

    this._lastTrace = {
      gas: result.gasUsed.toNumber(),
      failed: result.execResult.exceptionError !== undefined,
      returnValue: result.execResult.returnValue.toString("hex"),
      structLogs: rpcStructLogs,
    };

    next();
  }

  private async _messageToNestedStructLogs(
    message: DebugMessage,
    address: string
  ): Promise<NestedStructLogs> {
    const nestedStructLogs: NestedStructLogs = [];

    for (const [i, messageOrStructLog] of message.structLogs.entries()) {
      if (isStructLog(messageOrStructLog)) {
        const structLog: StructLog = messageOrStructLog;

        nestedStructLogs.push(structLog);

        // update the storage of the current address
        const addressStorage = this._addressToStorage[address] ?? {};
        structLog.storage = {
          ...addressStorage,
          ...structLog.storage,
        };
        this._addressToStorage[address] = {
          ...structLog.storage,
        };

        // sometimes the memSize has the correct value
        // for the memory length, in those cases we increase
        // the memory to reflect this
        if (structLog.memSize > structLog.memory.length) {
          const wordsToAdd = structLog.memSize - structLog.memory.length;
          for (let k = 0; k < wordsToAdd; k++) {
            structLog.memory.push(EMPTY_MEMORY_WORD);
          }
        }

        if (i === 0) {
          continue;
        }

        let previousStructLog = nestedStructLogs[nestedStructLogs.length - 2];

        if (Array.isArray(previousStructLog)) {
          previousStructLog = nestedStructLogs[nestedStructLogs.length - 3];
        } else {
          // if the previous log is not a message, we update its gasCost
          // using the gas difference between both steps
          previousStructLog.gasCost = previousStructLog.gas - structLog.gas;
        }

        assertHardhatInvariant(
          !Array.isArray(previousStructLog),
          "There shouldn't be two messages one after another"
        );

        // the increase in memory size of a revert is immediately
        // reflected, so we don't treat it as a memory expansion
        // of the previous step
        if (structLog.op !== "REVERT") {
          const memoryLengthDifference =
            structLog.memory.length - previousStructLog.memory.length;
          for (let k = 0; k < memoryLengthDifference; k++) {
            previousStructLog.memory.push(EMPTY_MEMORY_WORD);
          }
        }
      } else {
        const subMessage: DebugMessage = messageOrStructLog;

        const lastStructLog = nestedStructLogs[nestedStructLogs.length - 1];

        assertHardhatInvariant(
          !Array.isArray(lastStructLog),
          "There shouldn't be two messages one after another"
        );

        const isDelegateCall = lastStructLog.op === "DELEGATECALL";

        const messageNestedStructLogs = await this._messageToNestedStructLogs(
          subMessage,
          isDelegateCall ? address : subMessage.to
        );

        nestedStructLogs.push(messageNestedStructLogs);
      }
    }

    return nestedStructLogs;
  }

  private _getMemory(step: InterpreterStep): string[] {
    const memory = Buffer.from(step.memory)
      .toString("hex")
      .match(/.{1,64}/g);

    const result = memory === null ? [] : [...memory];

    return result;
  }

  private _getStack(step: InterpreterStep): string[] {
    const stack = step.stack
      .slice()
      .map((el: BN) => el.toString("hex").padStart(64, "0"));
    return stack;
  }

  private async _stepToStructLog(step: InterpreterStep): Promise<StructLog> {
    const memory = this._getMemory(step);
    const stack = this._getStack(step);

    let gasCost = step.opcode.fee;

    const storage: Storage = {};

    if (step.opcode.name === "SLOAD") {
      const address = step.address;
      const [keyBuffer] = this._getFromStack(stack, 1);
      const key: Buffer = setLength(keyBuffer, 32);

      const storageValue = await this._getContractStorage(address, key);

      storage[toWord(key)] = toWord(storageValue);
    } else if (step.opcode.name === "SSTORE") {
      const [keyBuffer, valueBuffer] = this._getFromStack(stack, 2);
      const key = toWord(keyBuffer);
      const storageValue = toWord(valueBuffer);

      storage[key] = storageValue;
    } else if (step.opcode.name === "REVERT") {
      const [offsetBuffer, lengthBuffer] = this._getFromStack(stack, 2);
      const length = new BN(lengthBuffer);
      const offset = new BN(offsetBuffer);

      const [gasIncrease, addedWords] = this._memoryExpansion(
        memory.length,
        length.add(offset)
      );

      gasCost += gasIncrease;

      for (let i = 0; i < addedWords; i++) {
        memory.push(EMPTY_MEMORY_WORD);
      }
    } else if (step.opcode.name === "CREATE2") {
      const [, , memoryUsedBuffer] = this._getFromStack(stack, 3);
      const memoryUsed = new BN(memoryUsedBuffer);
      const sha3ExtraCost = divUp(memoryUsed, 32)
        .muln(this._sha3WordGas())
        .toNumber();
      gasCost += sha3ExtraCost;
    } else if (
      step.opcode.name === "CALL" ||
      step.opcode.name === "STATICCALL" ||
      step.opcode.name === "DELEGATECALL"
    ) {
      // this is a port of what geth does to compute the
      // gasCost of a *CALL step, with some simplifications
      // because we don't support pre-spuriousDragon hardforks
      let valueBuffer = Buffer.from([]);
      let [
        callCostBuffer,
        recipientAddressBuffer,
        inBuffer,
        inSizeBuffer,
        outBuffer,
        outSizeBuffer,
      ] = this._getFromStack(stack, 6);

      // CALL has 7 parameters
      if (step.opcode.name === "CALL") {
        [
          callCostBuffer,
          recipientAddressBuffer,
          valueBuffer,
          inBuffer,
          inSizeBuffer,
          outBuffer,
          outSizeBuffer,
        ] = this._getFromStack(stack, 7);
      }

      const callCost = new BN(callCostBuffer);

      const value = new BN(valueBuffer);

      const memoryLength = memory.length;
      const inBN = new BN(inBuffer);
      const inSizeBN = new BN(inSizeBuffer);
      const inPosition = inSizeBN.isZero() ? inSizeBN : inBN.add(inSizeBN);
      const outBN = new BN(outBuffer);
      const outSizeBN = new BN(outSizeBuffer);
      const outPosition = outSizeBN.isZero() ? outSizeBN : outBN.add(outSizeBN);
      const memSize = inPosition.gt(outPosition) ? inPosition : outPosition;

      const constantGas = this._callConstantGas();
      const availableGas = step.gasLeft.toNumber() - constantGas;

      const [memoryGas] = this._memoryExpansion(memoryLength, memSize);

      const dynamicGas = await this._callDynamicGas(
        recipientAddressBuffer.slice(-20),
        value,
        availableGas,
        memoryGas,
        callCost
      );

      gasCost = constantGas + dynamicGas;
    } else if (step.opcode.name === "CALLCODE") {
      // finding an existing tx that uses CALLCODE or compiling a contract
      // so that it uses tihs opcode is hard,
      // so we just throw
      throw new InvalidInputError(
        "Transactions that use CALLCODE are not supported"
      );
    }

    const structLog: StructLog = {
      pc: step.pc,
      op: step.opcode.name,
      gas: step.gasLeft.toNumber(),
      gasCost,
      depth: step.depth + 1,
      stack,
      memory,
      storage,
      memSize: step.memoryWordCount.toNumber(),
    };

    return structLog;
  }

  private _memoryGas(): number {
    return this._vm._common.param("gasPrices", "memory");
  }

  private _sha3WordGas(): number {
    return this._vm._common.param("gasPrices", "sha3Word");
  }

  private _callConstantGas(): number {
    return this._vm._common.param("gasPrices", "call");
  }

  private _callNewAccountGas(): number {
    return this._vm._common.param("gasPrices", "callNewAccount");
  }

  private _callValueTransferGas(): number {
    return this._vm._common.param("gasPrices", "callValueTransfer");
  }

  private _isAddressEmpty(address: Buffer): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this._vm.stateManager.accountIsEmpty(
        address,
        (err: Error | null, result: boolean) => {
          if (err !== null) {
            return reject(err);
          }

          return resolve(result);
        }
      );
    });
  }

  private _getContractStorage(address: Buffer, key: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this._vm.stateManager.getContractStorage(
        address,
        key,
        (err: Error | null, result: Buffer) => {
          if (err !== null) {
            return reject(result);
          }

          return resolve(result);
        }
      );
    });
  }

  private async _callDynamicGas(
    address: Buffer,
    value: BN,
    availableGas: number,
    memoryGas: number,
    callCost: BN
  ): Promise<number> {
    let gas = 0;

    const transfersValue = !value.isZero();
    const addressIsEmpty = await this._isAddressEmpty(address);

    if (transfersValue && addressIsEmpty) {
      gas += this._callNewAccountGas();
    }

    if (transfersValue) {
      gas += this._callValueTransferGas();
    }

    gas += memoryGas;

    gas += this._callGas(availableGas, gas, callCost);

    return gas;
  }

  private _callGas(availableGas: number, base: number, callCost: BN): number {
    availableGas -= base;

    const gas = availableGas - Math.floor(availableGas / 64);

    if (callCost.gtn(gas)) {
      return gas;
    }

    return callCost.toNumber();
  }

  /**
   * Returns the increase in gas and the number of added words
   */
  private _memoryExpansion(
    currentWordsLength: number,
    newSize: BN
  ): [number, number] {
    const newWordsLength = divUp(newSize, 32).toNumber();

    const wordsDiff = newWordsLength - currentWordsLength;

    if (wordsDiff > 0) {
      return [wordsDiff * this._memoryGas(), wordsDiff];
    }
    return [0, 0];
  }

  private _getFromStack(stack: string[], count: number): Buffer[] {
    return stack
      .slice(-count)
      .reverse()
      .map((value) => `0x${value}`)
      .map(toBuffer);
  }
}

function divUp(x: BN, y: number | BN): BN {
  y = new BN(y);

  let result = x.div(y);

  if (!x.mod(y).eqn(0)) {
    result = result.addn(1);
  }

  return result;
}

function toWord(b: Buffer): string {
  return b.toString("hex").padStart(64, "0");
}