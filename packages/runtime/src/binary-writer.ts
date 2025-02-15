import type {BinaryWriteOptions, IBinaryWriter, WireType} from "./binary-format-contract";
import {PbLong, PbULong} from "./pb-long";
import {varint32write, varint64write} from "./goog-varint";
import {assertFloat32, assertInt32, assertUInt32} from "./assert";


const defaultsWrite: Readonly<BinaryWriteOptions> = {
    writeUnknownFields: true,
    writerFactory: () => new BinaryWriter(),
};


/**
 * Make options for writing binary data form partial options.
 */
export function binaryWriteOptions(options?: Partial<BinaryWriteOptions>): Readonly<BinaryWriteOptions> {
    return options ? {...defaultsWrite, ...options} : defaultsWrite;
}


/**
 * TextEncoderLike is the subset of the TextEncoder API required by protobuf-ts.
 */
interface TextEncoderLike {
    encode(input?: string): Uint8Array;
}

export class BinaryWriter implements IBinaryWriter {


    /**
     * We cannot allocate a buffer for the entire output
     * because we don't know it's size.
     *
     * So we collect smaller chunks of known size and
     * concat them later.
     *
     * Use `raw()` to push data to this array. It will flush
     * `buf` first.
     */
    private chunks: Uint8Array[];

    /**
     * A growing buffer for byte values. If you don't know
     * the size of the data you are writing, push to this
     * array.
     */
    protected buf: number[];

    /**
     * Previous fork states.
     */
    private stack: Array<{ chunks: Uint8Array[], buf: number[] }> = [];

    /**
     * Text encoder instance to convert UTF-8 to bytes.
     */
    private readonly textEncoder: TextEncoderLike;


    constructor(textEncoder?: TextEncoderLike) {
        this.textEncoder = textEncoder ?? new TextEncoder();
        this.chunks = [];
        this.buf = [];
    }


    /**
     * Return all bytes written and reset this writer.
     */
    finish(): Uint8Array {
        this.chunks.push(new Uint8Array(this.buf)); // flush the buffer
        let len = 0;
        for (let i = 0; i < this.chunks.length; i++)
            len += this.chunks[i].length;
        const bytes = new Uint8Array(len);
        let offset = 0;
        for (let i = 0; i < this.chunks.length; i++) {
            bytes.set(this.chunks[i], offset)
            offset += this.chunks[i].length;
        }
        this.chunks = [];
        return bytes;
    }


    /**
     * Start a new fork for length-delimited data like a message
     * or a packed repeated field.
     *
     * Must be joined later with `join()`.
     */
    fork(): IBinaryWriter {
        this.stack.push({chunks: this.chunks, buf: this.buf});
        this.chunks = [];
        this.buf = [];
        return this;
    }


    /**
     * Join the last fork. Write its length and bytes, then
     * return to the previous state.
     */
    join(): IBinaryWriter {

        // get chunk of fork
        const chunk = this.finish();

        // restore previous state
        const prev = this.stack.pop();
        if (!prev)
            throw new Error('invalid state, fork stack empty');
        this.chunks = prev.chunks;
        this.buf = prev.buf;

        // write length of chunk as varint
        this.uint32(chunk.byteLength);
        return this.raw(chunk);
    }


    /**
     * Writes a tag (field number and wire type).
     *
     * Equivalent to `uint32( (fieldNo << 3 | type) >>> 0 )`.
     *
     * Generated code should compute the tag ahead of time and call `uint32()`.
     */
    tag(fieldNo: number, type: WireType): IBinaryWriter {
        return this.uint32((fieldNo << 3 | type) >>> 0);
    }


    /**
     * Write a chunk of raw bytes.
     */
    raw(chunk: Uint8Array): IBinaryWriter {
        if (this.buf.length) {
            this.chunks.push(new Uint8Array(this.buf));
            this.buf = [];
        }
        this.chunks.push(chunk);
        return this;
    }


    /**
     * Write a `uint32` value, an unsigned 32 bit varint.
     */
    uint32(value: number): IBinaryWriter {
        assertUInt32(value);

        // write value as varint 32, inlined for speed
        while (value > 0x7f) {
            this.buf.push((value & 0x7f) | 0x80);
            value = value >>> 7;
        }
        this.buf.push(value);

        return this;
    }

    /**
     * Write a `int32` value, a signed 32 bit varint.
     */
    int32(value: number): IBinaryWriter {
        assertInt32(value);
        varint32write(value, this.buf);
        return this;
    }

    /**
     * Write a `bool` value, a variant.
     */
    bool(value: boolean): IBinaryWriter {
        this.buf.push(value ? 1 : 0);
        return this;
    }

    /**
     * Write a `bytes` value, length-delimited arbitrary data.
     */
    bytes(value: Uint8Array): IBinaryWriter {
        this.uint32(value.byteLength); // write length of chunk as varint
        return this.raw(value);
    }

    /**
     * Write a `string` value, length-delimited data converted to UTF-8 text.
     */
    string(value: string): IBinaryWriter {
        const chunk = this.textEncoder.encode(value);
        this.uint32(chunk.byteLength); // write length of chunk as varint
        return this.raw(chunk);
    }

    /**
     * Write a `float` value, 32-bit floating point number.
     */
    float(value: number): IBinaryWriter {
        assertFloat32(value);
        const chunk = new Uint8Array(4);
        new DataView(chunk.buffer).setFloat32(0, value, true);
        return this.raw(chunk);
    }

    /**
     * Write a `double` value, a 64-bit floating point number.
     */
    double(value: number): IBinaryWriter {
        const chunk = new Uint8Array(8);
        new DataView(chunk.buffer).setFloat64(0, value, true);
        return this.raw(chunk);
    }

    /**
     * Write a `fixed32` value, an unsigned, fixed-length 32-bit integer.
     */
    fixed32(value: number): IBinaryWriter {
        assertUInt32(value);
        const chunk = new Uint8Array(4);
        new DataView(chunk.buffer).setUint32(0, value, true);
        return this.raw(chunk);
    }

    /**
     * Write a `sfixed32` value, a signed, fixed-length 32-bit integer.
     */
    sfixed32(value: number): IBinaryWriter {
        assertInt32(value);
        const chunk = new Uint8Array(4);
        new DataView(chunk.buffer).setInt32(0, value, true);
        return this.raw(chunk);
    }

    /**
     * Write a `sint32` value, a signed, zigzag-encoded 32-bit varint.
     */
    sint32(value: number): IBinaryWriter {
        assertInt32(value);
        // zigzag encode
        value = ((value << 1) ^ (value >> 31)) >>> 0;
        varint32write(value, this.buf);
        return this;
    }

    /**
     * Write a `fixed64` value, a signed, fixed-length 64-bit integer.
     */
    sfixed64(value: string | number | bigint): IBinaryWriter {
        const chunk = new Uint8Array(8);
        const view = new DataView(chunk.buffer);
        const long = PbLong.from(value);
        view.setInt32(0, long.lo, true);
        view.setInt32(4, long.hi, true);
        return this.raw(chunk);
    }

    /**
     * Write a `fixed64` value, an unsigned, fixed-length 64 bit integer.
     */
    fixed64(value: string | number | bigint): IBinaryWriter {
        const chunk = new Uint8Array(8);
        const view = new DataView(chunk.buffer);
        const long = PbULong.from(value);
        view.setInt32(0, long.lo, true);
        view.setInt32(4, long.hi, true);
        return this.raw(chunk);
    }

    /**
     * Write a `int64` value, a signed 64-bit varint.
     */
    int64(value: string | number | bigint): IBinaryWriter {
        const long = PbLong.from(value);
        varint64write(long.lo, long.hi, this.buf);
        return this;
    }

    /**
     * Write a `sint64` value, a signed, zig-zag-encoded 64-bit varint.
     */
    sint64(value: string | number | bigint): IBinaryWriter {
        const long = PbLong.from(value),
            // zigzag encode
            sign = long.hi >> 31,
            lo = (long.lo << 1) ^ sign,
            hi = ((long.hi << 1) | (long.lo >>> 31)) ^ sign;
        varint64write(lo, hi, this.buf);
        return this;
    }

    /**
     * Write a `uint64` value, an unsigned 64-bit varint.
     */
    uint64(value: string | number | bigint): IBinaryWriter {
        const long = PbULong.from(value);
        varint64write(long.lo, long.hi, this.buf);
        return this;
    }


}

