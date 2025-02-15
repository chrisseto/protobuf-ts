import type {BinaryReadOptions, IBinaryReader} from "./binary-format-contract";
import {UnknownFieldHandler, WireType} from "./binary-format-contract";
import type {FieldInfo, PartialMessageInfo} from "./reflection-info";
import {LongType, ScalarType} from "./reflection-info";
import {reflectionLongConvert} from "./reflection-long-convert";
import {reflectionScalarDefault} from "./reflection-scalar-default";
import type {UnknownMap, UnknownMessage, UnknownOneofGroup, UnknownScalar} from "./unknown-types";


/**
 * Reads proto3 messages in binary format using reflection information.
 *
 * https://developers.google.com/protocol-buffers/docs/encoding
 */
export class ReflectionBinaryReader {


    // protected readonly info: MessageInfo;
    protected fieldNoToField?: ReadonlyMap<number, FieldInfo>;


    constructor(private readonly info: PartialMessageInfo) {
    }


    protected prepare() {
        if (!this.fieldNoToField) {
            const fieldsInput = this.info.fields ?? [];
            this.fieldNoToField = new Map<number, FieldInfo>(fieldsInput.map(field => [field.no, field]));
        }
    }


    /**
     * Reads a message from binary format into the target message.
     *
     * Repeated fields are appended. Map entries are added, overwriting
     * existing keys.
     *
     * If a message field is already present, it will be merged with the
     * new data.
     */
    read<T extends object>(reader: IBinaryReader, message: T, options: BinaryReadOptions, length?: number): void {
        this.prepare();

        const end = length === undefined ? reader.len : reader.pos + length;
        while (reader.pos < end) {

            // read the tag and find the field
            const [fieldNo, wireType] = reader.tag(), field = this.fieldNoToField!.get(fieldNo);
            if (!field) {
                const u = options.readUnknownField;
                if (u == "throw")
                    throw new Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.info.typeName}`);
                const d = reader.skip(wireType);
                if (u !== false)
                    (u === true ? UnknownFieldHandler.onRead : u)(this.info.typeName, message, fieldNo, wireType, d);
                continue;
            }

            // target object for the field we are reading
            let target: UnknownMessage | UnknownOneofGroup = message as UnknownMessage,
                repeated = field.repeat,
                localName = field.localName;

            // if field is member of oneof ADT, use ADT as target
            if (field.oneof) {
                target = target[field.oneof] as UnknownOneofGroup;
                // if other oneof member selected, set new ADT
                if (target.oneofKind !== localName)
                    target = (message as UnknownMessage)[field.oneof] = {
                        oneofKind: localName
                    };
            }

            // we have handled oneof above, we just have read the value into `target[localName]`
            switch (field.kind) {
                case "scalar":
                case "enum":
                    const T = field.kind == "enum" ? ScalarType.INT32 : field.T;
                    const L = field.kind == "scalar" ? field.L : undefined;
                    if (repeated) {
                        const arr = target[localName] as any[]; // safe to assume presence of array, oneof cannot contain repeated values
                        if (wireType == WireType.LengthDelimited && T != ScalarType.STRING && T != ScalarType.BYTES) {
                            const e = reader.uint32() + reader.pos;
                            while (reader.pos < e)
                                arr.push(this.scalar(reader, T, L));
                        } else
                            arr.push(this.scalar(reader, T, L));
                    } else
                        target[localName] = this.scalar(reader, T, L);
                    break;

                case "message":
                    if (repeated) {
                        const arr = target[localName] as any[]; // safe to assume presence of array, oneof cannot contain repeated values
                        const msg = field.T().internalBinaryRead(reader, reader.uint32(), options);
                        arr.push(msg);
                    } else
                        target[localName] = field.T().internalBinaryRead(reader, reader.uint32(), options, target[localName]);
                    break;

                case "map":
                    const [mapKey, mapVal] = this.mapEntry(field, reader, options);
                    // safe to assume presence of map object, oneof cannot contain repeated values
                    (target[localName] as UnknownMap)[mapKey] = mapVal;
                    break;
            }

        }
    }


    /**
     * Read a map field, expecting key field = 1, value field = 2
     */
    protected mapEntry(field: FieldInfo & { kind: "map" }, reader: IBinaryReader, options: BinaryReadOptions): [string | number, UnknownMap[string]] {
        const length = reader.uint32();
        const end = reader.pos + length;
        let key: string | number | undefined = undefined; // javascript only allows number or string for object properties
        let val: any = undefined;
        while (reader.pos < end) {
            const [fieldNo, wireType] = reader.tag();
            switch (fieldNo) {
                case 1:
                    if (field.K == ScalarType.BOOL)
                        key = reader.bool().toString();
                    else
                        // long types are read as string, number types are okay as number
                        key = this.scalar(reader, field.K, LongType.STRING) as string | number;
                    break;

                case 2:
                    switch (field.V.kind) {
                        case "scalar":
                            val = this.scalar(reader, field.V.T, field.V.L);
                            break;
                        case "enum":
                            val = reader.int32();
                            break;
                        case "message":
                            val = field.V.T().internalBinaryRead(reader, reader.uint32(), options);
                            break;
                    }
                    break;

                default:
                    throw new Error(`Unknown field ${fieldNo} (wire type ${wireType}) in map entry for ${this.info.typeName}#${field.name}`);
            }
        }
        if (key === undefined) {
            const keyRaw = reflectionScalarDefault(field.K);
            key = field.K == ScalarType.BOOL ? keyRaw.toString() : keyRaw as string | number;
        }
        if (val === undefined)
            switch (field.V.kind) {
                case "scalar":
                    val = reflectionScalarDefault(field.V.T, field.V.L);
                    break;
                case "enum":
                    val = 0;
                    break;
                case "message":
                    val = field.V.T().create();
                    break;
            }

        return [key, val];
    }


    protected scalar(reader: IBinaryReader, type: ScalarType, longType: LongType | undefined): UnknownScalar {
        switch (type) {
            case ScalarType.INT32:
                return reader.int32();
            case ScalarType.STRING:
                return reader.string();
            case ScalarType.BOOL:
                return reader.bool();
            case ScalarType.DOUBLE:
                return reader.double();
            case ScalarType.FLOAT:
                return reader.float();
            case ScalarType.INT64:
                return reflectionLongConvert(reader.int64(), longType);
            case ScalarType.UINT64:
                return reflectionLongConvert(reader.uint64(), longType);
            case ScalarType.FIXED64:
                return reflectionLongConvert(reader.fixed64(), longType);
            case ScalarType.FIXED32:
                return reader.fixed32();
            case ScalarType.BYTES:
                return reader.bytes();
            case ScalarType.UINT32:
                return reader.uint32();
            case ScalarType.SFIXED32:
                return reader.sfixed32();
            case ScalarType.SFIXED64:
                return reflectionLongConvert(reader.sfixed64(), longType);
            case ScalarType.SINT32:
                return reader.sint32();
            case ScalarType.SINT64:
                return reflectionLongConvert(reader.sint64(), longType);
        }
    }


}
