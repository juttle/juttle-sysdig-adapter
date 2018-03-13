'use strict';

function sysdig_Adapter(config) {
    return {
        name: 'sysdig',
        read: require('./read'),
    };
}

module.exports = sysdig_Adapter;
