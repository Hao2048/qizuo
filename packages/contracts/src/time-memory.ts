import {Type,type Static} from 'typebox';
const Id=Type.String({minLength:1,maxLength:200});
export const TimeMemoryRule=Type.Union([
 Type.Object({kind:Type.Literal('once'),at:Type.String({minLength:1,maxLength:80})},{additionalProperties:false}),
 Type.Object({kind:Type.Literal('daily'),time:Type.String({pattern:'^([01][0-9]|2[0-3]):[0-5][0-9]$'}),timezone:Id},{additionalProperties:false}),
 Type.Object({kind:Type.Literal('weekly'),time:Type.String({pattern:'^([01][0-9]|2[0-3]):[0-5][0-9]$'}),timezone:Id,weekdays:Type.Array(Type.Integer({minimum:0,maximum:6,description:'0=周日，1=周一，依此至6=周六'}),{minItems:1,maxItems:7,uniqueItems:true})},{additionalProperties:false})
]);
export type TimeMemoryRule=Static<typeof TimeMemoryRule>;
export const TimeMemoryCreate=Type.Object({roleId:Id,title:Type.String({minLength:1,maxLength:200}),instructions:Type.String({minLength:1,maxLength:16000}),rule:TimeMemoryRule,projectId:Type.Optional(Id),enabled:Type.Optional(Type.Boolean())},{additionalProperties:false});
export type TimeMemoryCreate=Static<typeof TimeMemoryCreate>;
export const TimeMemoryInfo=Type.Object({id:Id,roleId:Id,title:Type.String(),instructions:Type.String(),rule:TimeMemoryRule,projectId:Type.Union([Id,Type.Null()]),enabled:Type.Boolean(),nextRun:Type.Union([Type.Number(),Type.Null()]),status:Type.String(),lastError:Type.String(),lastAt:Type.Union([Type.Number(),Type.Null()]),activeTaskId:Type.Union([Id,Type.Null()]),lastTaskId:Type.Union([Id,Type.Null()]),sourceTaskId:Type.Union([Id,Type.Null()]),createdAt:Type.Number()});
export type TimeMemoryInfo=Static<typeof TimeMemoryInfo>;
export const timeMemoryCommands={
 'time-memory:attention':{input:Type.Object({}),output:Type.Object({count:Type.Integer({minimum:0})})},
 'time-memory:list':{input:Type.Object({roleId:Id}),output:Type.Object({items:Type.Array(TimeMemoryInfo),now:Type.Number(),timezone:Id})},
 'time-memory:create':{input:TimeMemoryCreate,output:TimeMemoryInfo},
 'time-memory:setEnabled':{input:Type.Object({id:Id,roleId:Id,enabled:Type.Boolean()}),output:TimeMemoryInfo},
 'time-memory:remove':{input:Type.Object({id:Id,roleId:Id}),output:Type.Object({ok:Type.Boolean()})},
 'time-memory:run':{input:Type.Object({id:Id,roleId:Id}),output:Type.Object({taskId:Id})}
};
