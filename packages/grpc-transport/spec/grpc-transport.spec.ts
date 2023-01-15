import {GrpcTransport} from "../src";
import {ChannelCredentials} from "@grpc/grpc-js";

describe('GrpcTransport', () => {

    it('can be created', function () {
        const transport = new GrpcTransport({
            host: "fake",
            channelCredentials: ChannelCredentials.createInsecure()
        });
        expect(transport).toBeDefined();
    });

});
